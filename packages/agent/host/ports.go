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
	InitializeRuntimeSession(context.Context, RuntimeSessionInitialization) (storesqlite.Session, error)
	UpdateSessionTitle(context.Context, string, string, string) (storesqlite.Session, bool, error)
	ListChildSessions(context.Context, string, string) ([]storesqlite.Session, error)
}

// CanonicalRuntimeContextCASStore is the narrow durable commit required by a
// runtime configuration rebind. It remains optional so external read/custom
// stores are not source-broken; rebind fails closed when it is unavailable.
type CanonicalRuntimeContextCASStore interface {
	CompareAndSwapSessionRuntimeContext(context.Context, string, string, map[string]any, map[string]any) (storesqlite.Session, bool, error)
}

// RuntimeSessionRailPlacementResolver is the optional create-time capability
// that resolves a prepared runtime's final canonical rail placement before a
// provider process starts. Keeping it separate preserves source compatibility
// for external CanonicalStore implementations; CreateSession fails closed
// when the capability is unavailable.
type RuntimeSessionRailPlacementResolver interface {
	ResolveRuntimeSessionRailPlacement(context.Context, ResolveRuntimeSessionRailPlacementInput) (*RailPlacement, error)
}

type RuntimeSessionInitialization struct {
	Session                    ProviderRuntimeSession
	RailPlacement              *RailPlacement
	RailPlacementAuthoritative bool
}

type CanonicalTurnStore interface {
	GetTurn(context.Context, string, string, string) (storesqlite.Turn, bool, error)
	GetProviderSessionResumeEvidence(context.Context, string, string) (storesqlite.ProviderSessionResumeEvidence, error)
	FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
	ListSessionTurnSummaries(context.Context, storesqlite.ListSessionTurnSummariesInput) (storesqlite.SessionTurnSummaryPage, error)
	ListLatestTurnInteractions(context.Context, string, []string) (map[string][]storesqlite.Interaction, error)
	ListSessionInteractions(context.Context, storesqlite.ListSessionInteractionsInput) ([]storesqlite.Interaction, error)
}

// CanonicalInteractionTreeStore is an optional read capability. Keeping it
// separate preserves source compatibility for external CanonicalStore
// implementations that do not consume execution-tree projections.
type CanonicalInteractionTreeStore interface {
	GetSessionInteractionTreeSnapshot(context.Context, storesqlite.SessionInteractionTreeQuery) (storesqlite.SessionInteractionTreeSnapshot, bool, error)
}

type CanonicalMessageStore interface {
	ListSessionMessages(context.Context, storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error)
}

// TurnSubmissionStore persists the lossless request envelope after the
// canonical Turn exists. Provider runtimes receive hydrated content, while
// replay reads attachment-reference form from this port.
type TurnSubmissionStore interface {
	RecordTurnSubmission(context.Context, storesqlite.TurnSubmission) (storesqlite.TurnSubmission, bool, error)
	GetTurnSubmission(context.Context, string, string, string) (storesqlite.TurnSubmission, bool, error)
}

// EffectiveHistoryStore owns the durable local half of an edit-retry saga.
// Its compound transitions atomically fence the Session history projection,
// the source/replacement Turns, and the runtime operation.
type EffectiveHistoryStore interface {
	GetSessionHistory(context.Context, string, string) (storesqlite.SessionHistory, bool, error)
	GetTurnHistory(context.Context, string, string, string) (storesqlite.TurnHistory, bool, error)
	ListEffectiveSessionTurns(context.Context, string, string) ([]storesqlite.Turn, error)
	MarkEditRetryRollbackDispatched(context.Context, storesqlite.MarkEditRetryRollbackDispatchedInput) (storesqlite.RuntimeOperation, bool, error)
	ConfirmEditRetryRollback(context.Context, storesqlite.ConfirmEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error)
	AbortEditRetryRollback(context.Context, storesqlite.AbortEditRetryRollbackInput) (storesqlite.RuntimeOperation, bool, error)
	PrepareEditRetryReplacementRedispatch(context.Context, storesqlite.PrepareEditRetryReplacementRedispatchInput) (storesqlite.RuntimeOperation, bool, error)
	CompleteEditRetryRuntimeOperation(context.Context, storesqlite.CompleteEditRetryRuntimeOperationInput) (storesqlite.RuntimeOperationCompletion, bool, error)
	FailEditRetryRecovery(context.Context, storesqlite.FailEditRetryRecoveryInput) (storesqlite.RuntimeOperation, bool, error)
	QuarantineEditRetryOperation(context.Context, storesqlite.QuarantineEditRetryOperationInput) (storesqlite.RuntimeOperation, bool, error)
	ClearAbandonedEditRetryFence(context.Context, storesqlite.ClearAbandonedEditRetryFenceInput) (bool, error)
}

type CanonicalSubmitClaimStore interface {
	PrepareSubmitClaim(context.Context, storesqlite.SubmitClaimPrepare) (storesqlite.SubmitClaim, bool, error)
	AcceptSubmitClaim(context.Context, string, string, string, string, int64) (storesqlite.SubmitClaim, bool, error)
	RejectSubmitClaim(context.Context, string, string, string, string, int64) (storesqlite.SubmitClaim, bool, error)
	DeleteSubmitClaim(context.Context, string, string, string) (bool, error)
}

// SessionForkStore is an independent durable saga boundary. Provider dispatch
// must never share a transaction with canonical history cloning.
type SessionForkStore interface {
	SessionForkTurnIdentityStore
	GetSessionForkSource(context.Context, string, string) (storesqlite.Session, bool, error)
	CheckSessionForkThroughTurn(context.Context, string, string, string) (storesqlite.SessionForkBoundary, bool, error)
	PrepareSessionFork(context.Context, storesqlite.SessionForkPrepare) (storesqlite.SessionForkOperation, bool, error)
	GetSessionForkOperation(context.Context, string, string) (storesqlite.SessionForkOperation, bool, error)
	GetSessionForkOperationByRequest(context.Context, string, string) (storesqlite.SessionForkOperation, bool, error)
	MarkSessionForkDispatching(context.Context, string, string, int64) (storesqlite.SessionForkOperation, bool, error)
	FailPreparedSessionFork(context.Context, string, string, string, int64) (storesqlite.SessionForkOperation, bool, error)
	FailAcceptedSessionFork(context.Context, string, string, string, int64) (storesqlite.SessionForkOperation, bool, error)
	RecordSessionForkProviderResult(context.Context, storesqlite.SessionForkProviderResult) (storesqlite.SessionForkOperation, bool, error)
	CommitSessionFork(context.Context, string, string, int64) (storesqlite.SessionForkCommitResult, error)
	AcknowledgeSessionForkOperation(context.Context, string, string, int64) (storesqlite.SessionForkOperation, bool, bool, error)
	GetSessionForkLineage(context.Context, string, string) (storesqlite.SessionForkLineage, bool, error)
}

type SessionForkTurnIdentityStore interface {
	ListSessionForkTurnIdentities(
		context.Context,
		string,
		string,
	) ([]storesqlite.SessionForkTurnIdentity, error)
}

type SessionForkAttachmentStore interface {
	ListSessionForkAttachmentBindings(
		context.Context,
		string,
		string,
	) ([]storesqlite.SessionForkAttachmentBinding, error)
}

type SessionForkAttachmentStager interface {
	StageSessionForkAttachments(
		context.Context,
		string,
		string,
		string,
		[]storesqlite.SessionForkAttachmentBinding,
	) error
}

// SessionForkRecoveryStore is workspace-global because startup recovery must
// enumerate operations without guessing product-owned workspace identities.
type SessionForkRecoveryStore interface {
	ListRecoverableSessionForkOperationsPage(
		context.Context,
		storesqlite.SessionForkRecoveryCursor,
		int,
	) ([]storesqlite.SessionForkOperation, error)
}

// SessionForkRuntime resolves and invokes the exact provider adapter selected
// by a source runtime. Adapters without through-Turn support report it as
// false, so Host never dispatches an emulated provider fork.
type SessionForkRuntime interface {
	ResolveSessionFork(context.Context, ProviderRuntimeSession) (SessionForkDriverDescriptor, error)
	CanForkProviderTurn(context.Context, RuntimeProviderTurnForkabilityInput) (bool, error)
	ForkSession(context.Context, RuntimeSessionForkInput) (RuntimeSessionForkResult, error)
}

// SessionForkTurnBindingRecoveryRuntime performs a read-only provider-history
// lookup for an exact opaque token or a complete legacy text proof. It must
// never infer identity from Turn position.
type SessionForkTurnBindingRecoveryRuntime interface {
	RecoverProviderTurnBinding(
		context.Context,
		RuntimeProviderTurnBindingRecoveryInput,
	) (RuntimeProviderTurnBindingRecoveryResult, error)
}

type SessionForkTurnBindingRecoveryStore interface {
	FindSubmitClaimByCanonicalTurn(
		context.Context,
		string,
		string,
		string,
	) (storesqlite.SubmitClaim, bool, error)
	RecoverProviderTurnBinding(
		context.Context,
		storesqlite.ProviderTurnBindingRecovery,
	) (storesqlite.ProviderTurnBindingRecoveryResult, error)
}

// SideConversationRuntime opens only the provider-native ephemeral branch.
// Host owns lifecycle/idempotency and then reuses RuntimeController for
// execution, cancellation, interaction responses, and close.
type SideConversationRuntime interface {
	ResolveSideConversation(context.Context, ProviderRuntimeSession) (SideConversationCapabilities, error)
	OpenSideConversation(context.Context, RuntimeOpenSideConversationInput) (OpenSideConversationResult, error)
}

// SessionForkContextPolicy decides whether host-owned session context can be
// transferred safely and returns the exact target context to freeze at
// prepare. Product-specific resource ownership (for example worktrees) stays
// out of the provider adapter and the canonical store.
type SessionForkContextPolicy interface {
	PrepareSessionForkTargetContext(
		context.Context,
		storesqlite.Session,
		ProviderRuntimeSession,
	) (SessionForkTargetContext, error)
}

// SessionForkProviderStateBinder transfers only the accepted provider child
// state needed by the target runtime namespace. Provider acceptance is already
// durable when this runs, so a failure retries only this local binding and
// never redispatches the provider mutation.
type SessionForkProviderStateBinder interface {
	SupportsSessionForkProviderStateBinding(provider string) bool
	BindSessionForkProviderState(context.Context, SessionForkProviderStateBinding) error
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

// SessionDeletionGuard lets a host adapter enforce product policy around the
// provider-neutral canonical closure. Admission is authoritative and occurs
// before runtime or canonical side effects. Reporting is observational and
// cannot change the Host command result.
type SessionDeletionGuard interface {
	AdmitDeleteSessions(context.Context, DeleteSessionsPlan) error
	ReportDeleteSessions(context.Context, DeleteSessionsReport)
}

// SessionPurgeStore is the narrow permanent-removal boundary. Retention and
// local-file ownership policies remain outside Host.
type SessionPurgeStore interface {
	PurgeDeletedSessions(context.Context, storesqlite.PurgeDeletedSessionsInput) (storesqlite.PurgeDeletedSessionsResult, error)
}

// DeletedSessionStore is the lossless tombstone read/restore/permanent-delete
// boundary. Restore is a lifecycle command; presentation and retention policy
// remain with the composing host adapter.
type DeletedSessionStore interface {
	ListDeletedSessions(context.Context, storesqlite.ListDeletedSessionsInput) (storesqlite.DeletedSessionPage, error)
	RestoreDeletedSession(context.Context, storesqlite.RestoreDeletedSessionInput) (storesqlite.RestoreDeletedSessionResult, error)
	PurgeDeletedSessionTrees(context.Context, storesqlite.PurgeDeletedSessionTreesInput) (storesqlite.PurgeDeletedSessionTreesResult, error)
}

// HistoricalSessionStateStore is the canonical persistence boundary used by
// Replay before normal Host recovery. The contract contains business entities,
// not rows, table names, or migration details.
type HistoricalSessionStateStore interface {
	CaptureHistoricalSessionGraph(
		context.Context,
		string,
		string,
	) (HistoricalSessionGraph, error)
	RestoreHistoricalSessionGraph(
		context.Context,
		HistoricalSessionGraphRestoreInput,
	) error
}

// RuntimeController is the provider-neutral live-runtime surface needed by
// create, resume, send, exact cancel, interactive, plan, title, and visibility
// workflows. Process transport and provider implementations stay behind it.
type RuntimeController interface {
	Start(context.Context, RuntimeStartInput) (RuntimeStartResult, error)
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

// RuntimeSessionInitializationPublisher is the explicit release half of a
// create-time canonical initialization barrier. CreateSession requires this
// capability before starting a provider Runtime; other Host workflows can use
// a narrower RuntimeController without pretending to support creation.
type RuntimeSessionInitializationPublisher interface {
	PublishSessionInitialization(context.Context, RuntimeSessionInitializationPublishInput) (ProviderRuntimeSession, error)
}

// RuntimeSessionRepreparer replaces an idle Session's live provider
// connection without changing its canonical or provider session identity.
// Implementations must serialize against Turn admission and fail when a Turn
// is active.
type RuntimeSessionRepreparer interface {
	Reprepare(context.Context, RuntimeResumeInput) (ProviderRuntimeSession, error)
}

// RuntimeSessionLiveness distinguishes a registered runtime Session from a
// live provider connection. It is required when Goal generation fencing is
// configured: background recovery must never guess liveness and reconnect an
// idle/offline Session merely to deliver deferred control work.
type RuntimeSessionLiveness interface {
	RuntimeSessionLive(workspaceID, agentSessionID string) bool
}

// RuntimeWorkspaceDisconnector exposes registered runtime sessions and
// releases only their live provider connection. It must preserve the runtime
// session record and provider resume identity, and must not invoke a
// provider-history session close operation.
type RuntimeWorkspaceDisconnector interface {
	WorkspaceRuntimeSessions(context.Context, string) ([]ProviderRuntimeSession, error)
	DisconnectRuntimeSession(context.Context, SessionRef) (bool, error)
}

// RuntimeWorkspaceDisconnectTargeter supports a reentrant detach that must
// defer semantic cleanup without targeting a later provider connection.
type RuntimeWorkspaceDisconnectTargeter interface {
	SnapshotWorkspaceRuntimeDisconnectTargets(string) []RuntimeDisconnectTarget
	DisconnectRuntimeSessionTarget(context.Context, RuntimeDisconnectTarget) (bool, error)
}

// RuntimeRetainedSettingsUpdater refreshes the settings snapshot kept by a
// disconnected runtime Session without starting its provider connection.
type RuntimeRetainedSettingsUpdater interface {
	UpdateRetainedSettings(context.Context, RuntimeUpdateSettingsInput) error
}

// RuntimeHistoryController is an optional semantic capability. Host lifecycle
// code never invokes provider-specific history methods directly.
type RuntimeHistoryController interface {
	SupportsEffectiveHistory(context.Context, RuntimeHistoryInput) (bool, error)
	ReadEffectiveHistory(context.Context, RuntimeHistoryInput) (RuntimeHistorySnapshot, error)
	RollbackLatestTurn(context.Context, RuntimeHistoryInput) (RuntimeHistoryMutationResult, error)
}

// RuntimeProviderTurnAcceptanceReconciler persists provider-history evidence
// through the runtime's ordinary activity projection. It is optional because
// providers without authoritative history cannot safely synthesize acceptance.
type RuntimeProviderTurnAcceptanceReconciler interface {
	ReconcileProviderTurnAcceptance(context.Context, RuntimeProviderTurnAcceptanceInput) error
}

type RuntimeSubmitProvenanceReporter interface {
	DurablyReportSubmitProvenance(context.Context, RuntimeSubmitProvenanceInput) error
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
// goal reconcile inbox work have been recovered.
type StaleTurnSettler interface {
	SettleStaleTurnsOnStartup(context.Context) error
}

type GoalStateStore interface {
	PrepareGoalControlOperation(context.Context, storesqlite.GoalControlOperationPrepare) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error)
	AdoptProviderGoalOperation(context.Context, storesqlite.ProviderGoalAdoption) (storesqlite.GoalControlOperation, storesqlite.SessionGoalState, bool, error)
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

type RuntimeGoalControlAppliedSink func(context.Context, RuntimeGoalControlAppliedInput) error

// GoalRuntimeControlLifecycleRegistrar lets the standard runtime adapter bind
// provider lifecycle back to the Host-owned Goal state machine. Product
// consumers must not reproduce this wiring themselves.
type GoalRuntimeControlLifecycleRegistrar interface {
	SetGoalControlAppliedSink(RuntimeGoalControlAppliedSink)
}

type GoalRuntimeReconciler interface {
	ReconcileGoal(context.Context, RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error)
}

type GoalRuntimeRecoveryPolicyResolver interface {
	GoalRecoveryPolicy(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error)
}

// GoalRuntimeGenerationFencer installs an exact, idempotent provider-runtime
// admission fence. It must not clear a newer Goal generation.
type GoalRuntimeGenerationFencer interface {
	FenceGoalGeneration(context.Context, RuntimeGoalGenerationFenceInput) error
}

type GoalGenerationFenceStore interface {
	PrepareGoalGenerationFence(context.Context, storesqlite.GoalGenerationFencePrepare) (storesqlite.GoalGenerationFence, bool, error)
	GetGoalGenerationFence(context.Context, string, string) (storesqlite.GoalGenerationFence, bool, error)
	ListGoalGenerationFencesForSession(context.Context, string, string) ([]storesqlite.GoalGenerationFence, error)
	ListClaimableGoalGenerationFences(context.Context, storesqlite.ListClaimableGoalGenerationFencesInput) ([]storesqlite.GoalGenerationFence, error)
	ClaimGoalGenerationFence(context.Context, storesqlite.ClaimGoalGenerationFenceInput) (storesqlite.GoalGenerationFence, bool, error)
	ReleaseGoalGenerationFence(context.Context, storesqlite.ReleaseGoalGenerationFenceInput) (storesqlite.GoalGenerationFence, bool, error)
	CompleteGoalGenerationFence(context.Context, storesqlite.CompleteGoalGenerationFenceInput) (storesqlite.GoalGenerationFence, bool, error)
	RequeueLeasedGoalGenerationFencesOnStartup(context.Context, int64) (int64, error)
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
	CodexSaverMode         bool
	RTKSaverMode           bool
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
	MCPServers        []MCPServerBinding
	ProviderTargetRef map[string]any
	Settings          *ComposerSettings
	RuntimeContext    map[string]any
}

type MCPServerBinding struct {
	Name    string
	Type    string
	URL     string
	Headers map[string]string
}

func cloneHostMCPServerBindings(input []MCPServerBinding) []MCPServerBinding {
	if len(input) == 0 {
		return nil
	}
	result := make([]MCPServerBinding, 0, len(input))
	for _, binding := range input {
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		binding.Headers = headers
		result = append(result, binding)
	}
	return result
}

type RuntimeCleanupInput struct {
	WorkspaceID    string
	AgentSessionID string
	Provider       string
	// OrphanActivationCleanup requests Tutti Mode activation cleanup for
	// runtime-only session state that never received a canonical tombstone.
	OrphanActivationCleanup bool
	// PreserveRecoverableState keeps provider resume identity and other
	// session-owned persistent resources while still releasing live/transient
	// runtime resources after a lossless soft delete.
	PreserveRecoverableState bool
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
//
// Adapters must not turn every LifecycleStep into a product analytics event.
// Prefer TerminalFailureObserver for aggregated failure telemetry.
type LifecycleObserver interface {
	ObserveLifecycleStep(context.Context, LifecycleStep)
}

// TerminalFailure is one aggregated failure fact for product telemetry.
// Host emits at most one observation per failed command or durable terminal
// settlement. It carries the failure stage and original error text so adapters
// can report without depending on user-supplied logs.
type TerminalFailure struct {
	Flow                          string
	FailureStage                  string
	WorkspaceID                   string
	AgentSessionID                string
	TurnID                        string
	OperationID                   string
	ClientSubmitID                string
	RequestID                     string
	Provider                      string
	ErrorCode                     string
	ErrorMessage                  string
	ProviderAcceptanceDiagnostics *RuntimeProviderAcceptanceDiagnostics
	ToolNameFamily                string
	InteractionKind               string
	TurnOutcome                   string
	// DurationMS is populated only when the canonical terminal fact carries a
	// valid start and settlement timestamp. Zero means unavailable.
	DurationMS int64
	// StartupReconciled distinguishes daemon-start interruption settlement from
	// a live provider terminal observation.
	StartupReconciled bool
	// IsChildSession marks provider-native subagent sessions (parent tool call).
	// Adapters may use it to distinguish child-session turn/tool failures from
	// root-session ones without a separate event family.
	IsChildSession bool
	Retryable      bool
}

// TerminalFailureObserver receives aggregated terminal failures. It must not
// influence command correctness; durable state remains in CanonicalStore.
type TerminalFailureObserver interface {
	ObserveTerminalFailure(context.Context, TerminalFailure)
}

// CommitObserver is the single post-commit wake surface. Implementations must
// not treat it as a durable fact carrier; reliable work is read back from
// canonical storage after the wake.
type CommitObserver interface {
	ObserveCommitted(context.Context, CommittedDelta) error
}
