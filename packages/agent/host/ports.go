package agenthost

import (
	"context"
	"time"

	agentactivity "github.com/tutti-os/tutti/packages/agent/daemon/activity"
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
	ListSessionInteractions(context.Context, storesqlite.ListSessionInteractionsInput) ([]storesqlite.Interaction, error)
}

type CanonicalSubmitClaimStore interface {
	PrepareSubmitClaim(context.Context, storesqlite.SubmitClaimPrepare) (storesqlite.SubmitClaim, bool, error)
	AcceptSubmitClaim(context.Context, string, string, string, string, int64) (storesqlite.SubmitClaim, bool, error)
	DeleteSubmitClaim(context.Context, string, string, string) (bool, error)
}

// CanonicalStore composes only the lifecycle facets required by the first Host
// extraction slices. Operation and goal facets remain separate until their
// coordinators move in later slices.
type CanonicalStore interface {
	CanonicalSessionStore
	CanonicalTurnStore
	CanonicalSubmitClaimStore
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

// StartupRecoveryPort temporarily hosts durable recovery participants that
// move into Host in later extraction slices. Host owns their ordering relative
// to runtime operations and stale-turn settlement.
type StartupRecoveryPort interface {
	RecoverBeforeStaleTurnSettlement(context.Context) error
}

type StaleTurnSettler interface {
	SettleStaleTurnsOnStartup(context.Context) error
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

// CommitObserver is a post-commit wake surface. Implementations must not treat
// it as a durable fact carrier; reliable work is read back from canonical
// storage after the wake.
type CommitObserver interface {
	ObserveAgentSessionState(context.Context, agentactivity.ReportSessionStateInput, agentactivity.ReportSessionStateReply)
	ObserveAgentSessionMessages(context.Context, agentactivity.ReportSessionMessagesInput, agentactivity.ReportSessionMessagesReply)
	ObserveRootTurnSettled(context.Context, string, string, storesqlite.Turn)
}
