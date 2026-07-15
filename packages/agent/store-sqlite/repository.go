// Package storesqlite provides an embeddable SQLite persistence layer for
// agent activity (sessions, messages, rail sections, generated files) and
// agent targets. It operates on an injected *sql.DB, keeps its own schema
// migration ledger, and makes no assumptions about the host schema beyond
// the tables it owns; host concerns (workspace existence, project paths,
// target normalization) are injected through Options.
package storesqlite

import "context"

// Repository is the public persistence contract for agent activity.
// All methods are scoped by a host-defined workspace ID.
type Repository interface {
	ClearSessions(context.Context, string) (ClearSessionsResult, error)
	DeleteSession(context.Context, string, string) (bool, error)
	DeleteSessionsBatch(context.Context, DeleteSessionsBatchInput) (DeleteSessionsBatchResult, error)
	GetSession(context.Context, string, string) (Session, bool, error)
	SessionDeleted(context.Context, string, string) (bool, error)
	GetLatestTurn(context.Context, string, string) (Turn, bool, error)
	GetTurn(context.Context, string, string, string) (Turn, bool, error)
	ListSessionInteractions(context.Context, ListSessionInteractionsInput) ([]Interaction, error)
	ListLatestTurns(context.Context, string, []string) (map[string]Turn, error)
	ListLatestTurnInteractions(context.Context, string, []string) (map[string][]Interaction, error)
	ListTurnsBySession(context.Context, string, map[string]string) (map[string]Turn, error)
	ListPendingInteractionsBySession(context.Context, string, []string) (map[string][]Interaction, error)
	ListSessionSection(context.Context, ListSessionSectionInput) (SessionSectionPage, bool, error)
	ListSessionSectionDeletionCandidates(context.Context, ListSessionSectionDeletionCandidatesInput) (SessionSectionDeletionCandidates, bool, error)
	ListSessionTurns(context.Context, string, string) ([]Turn, error)
	ListSessions(context.Context, string) ([]Session, bool, error)
	ListWorkspaceGeneratedFiles(context.Context, ListWorkspaceGeneratedFilesInput) (GeneratedFileList, bool, error)
	ListSessionMessages(context.Context, ListSessionMessagesInput) (MessagePage, bool, error)
	ReportActivityState(context.Context, ActivityStateReport) (ActivityStateReportResult, error)
	ReportSessionMessages(context.Context, SessionMessageReport) (MessageReportResult, error)
	ReportSessionState(context.Context, SessionStateReport) (StateReportResult, error)
	PrepareRuntimeOperation(context.Context, RuntimeOperationPrepare) (RuntimeOperation, bool, error)
	GetRuntimeOperation(context.Context, string, string) (RuntimeOperation, bool, error)
	ListClaimableRuntimeOperations(context.Context, ListClaimableRuntimeOperationsInput) ([]RuntimeOperation, error)
	ClaimRuntimeOperationLease(context.Context, ClaimRuntimeOperationLeaseInput) (RuntimeOperation, bool, error)
	ReleaseOrFailRuntimeOperation(context.Context, ReleaseOrFailRuntimeOperationInput) (RuntimeOperation, bool, error)
	RequeueLeasedRuntimeOperationsOnStartup(context.Context, int64) (int64, error)
	CompleteInteractiveRuntimeOperation(context.Context, CompleteInteractiveRuntimeOperationInput) (RuntimeOperationCompletion, bool, error)
	CompleteCancelRuntimeOperation(context.Context, CompleteCancelRuntimeOperationInput) (RuntimeOperationCompletion, bool, error)
	ListPendingRuntimeOperationEvents(context.Context, string, int) ([]RuntimeOperationEvent, error)
	MarkRuntimeOperationEventPublished(context.Context, string, int64, int64) (bool, error)
	SettleStaleTurns(context.Context) ([]StaleTurnSettlement, error)
	UpdateSessionPinned(context.Context, string, string, bool) (Session, bool, error)
	UpdateSessionTitle(context.Context, string, string, string) (Session, bool, error)
}

type ClearSessionsResult struct {
	RemovedMessages   int
	RemovedSessions   int
	RemovedSessionIDs []string
}

type MessageOrder string

const (
	MessageOrderAsc  MessageOrder = "asc"
	MessageOrderDesc MessageOrder = "desc"
)

type ListSessionMessagesInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	AfterVersion   uint64
	BeforeVersion  uint64
	Limit          int
	Order          MessageOrder
}

type ListWorkspaceGeneratedFilesInput struct {
	WorkspaceID string
	Query       string
	SessionCwd  string
	Limit       int
}

type GeneratedFile struct {
	Path  string
	Label string
}

type GeneratedFileList struct {
	WorkspaceID string
	Files       []GeneratedFile
}

type ListSessionSectionInput struct {
	WorkspaceID          string
	SectionKey           string
	AgentTargetID        string
	CursorSortTimeUnixMS int64
	CursorSessionID      string
	Limit                int
}

type ListSessionSectionDeletionCandidatesInput struct {
	WorkspaceID   string
	SectionKey    string
	AgentTargetID string
	ExcludePinned bool
}

type SessionSectionDeletionCandidates struct {
	WorkspaceID   string
	SectionKey    string
	AgentTargetID string
	ExcludePinned bool
	SessionIDs    []string
}

type DeleteSessionsBatchInput struct {
	WorkspaceID string
	SessionIDs  []string
}

type DeleteSessionsBatchResult struct {
	RemovedMessages   int
	RemovedSessions   int
	RemovedSessionIDs []string
}

const PinnedSessionPageKey = "pinned"

type SessionSectionPage struct {
	WorkspaceID string
	SectionKey  string
	Sessions    []Session
	HasMore     bool
	TotalCount  int
	NextCursor  string
}

type Session struct {
	ID                     string
	WorkspaceID            string
	Origin                 string
	UserID                 string
	AgentTargetID          string
	Provider               string
	ProviderSessionID      string
	Model                  string
	Settings               map[string]any
	Metadata               SessionMetadata
	InternalRuntimeContext map[string]any
	Cwd                    string
	Title                  string
	// ActiveTurnID is the protocol v2 turn reference: the id of the turn
	// currently in flight, empty when the session is idle.
	ActiveTurnID    string
	MessageVersion  uint64
	LastEventUnixMS int64
	StartedAtUnixMS int64
	EndedAtUnixMS   int64
	PinnedAtUnixMS  int64
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

// ActivityStateReport persists the session projection and its optional v2
// turn/interaction entities as one atomic unit. Child entities must identify
// the same workspace and session as Session.
type ActivityStateReport struct {
	Session     SessionStateReport
	Turn        *TurnTransition
	Interaction *InteractionUpsert
}

type ActivityStateReportResult struct {
	State             StateReportResult
	Turn              Turn
	TurnAccepted      bool
	Interaction       Interaction
	InteractionResult InteractionTransitionResult
}

// Closed protocol v2 turn phase vocabulary. The storage CHECK constraints
// mirror this list; keep both in sync with the openapi WorkspaceAgentTurnPhase
// enum.
const (
	TurnPhaseSubmitted = "submitted"
	TurnPhaseRunning   = "running"
	TurnPhaseWaiting   = "waiting"
	TurnPhaseSettling  = "settling"
	TurnPhaseSettled   = "settled"
)

// Closed protocol v2 turn outcome vocabulary; mirrors the openapi
// WorkspaceAgentTurnOutcome enum.
const (
	TurnOutcomeCompleted   = "completed"
	TurnOutcomeFailed      = "failed"
	TurnOutcomeCanceled    = "canceled"
	TurnOutcomeInterrupted = "interrupted"
)

// Turn is the protocol v2 turn entity: one user-submission-driven execution
// with its own phase, outcome, error, and file changes.
type Turn struct {
	WorkspaceID            string
	AgentSessionID         string
	TurnID                 string
	Phase                  string
	Outcome                string
	ErrorMessage           string
	ErrorCode              string
	FileChanges            map[string]any
	CompletedCommandKind   string
	CompletedCommandStatus string
	Backfilled             bool
	StartedAtUnixMS        int64
	SettledAtUnixMS        int64
	CreatedAtUnixMS        int64
	UpdatedAtUnixMS        int64
}

// TurnTransition records one turn phase transition. Transitions are written
// synchronously per phase change (no batching); a settled turn is terminal
// and rejects further transitions, which makes replays and cancel races
// idempotent.
type TurnTransition struct {
	WorkspaceID            string
	AgentSessionID         string
	TurnID                 string
	Phase                  string
	Outcome                string
	ErrorMessage           string
	ErrorCode              string
	FileChanges            map[string]any
	CompletedCommandKind   string
	CompletedCommandStatus string
	StartedAtUnixMS        int64
	SettledAtUnixMS        int64
	OccurredAtUnixMS       int64
}

// Closed protocol v2 interaction vocabulary; mirrors the openapi
// WorkspaceAgentInteractionKind / WorkspaceAgentInteractionStatus enums.
const (
	InteractionKindApproval = "approval"
	InteractionKindQuestion = "question"
	InteractionKindPlan     = "plan"

	InteractionStatusPending    = "pending"
	InteractionStatusAnswered   = "answered"
	InteractionStatusSuperseded = "superseded"
)

// Interaction is the protocol v2 interaction entity: an agent-initiated
// approval, question, or plan confirmation raised during a turn. Pending
// means present with status pending; there is no tri-state null protocol.
type Interaction struct {
	WorkspaceID     string
	AgentSessionID  string
	RequestID       string
	TurnID          string
	Kind            string
	Status          string
	ToolName        string
	Input           map[string]any
	Output          map[string]any
	Metadata        map[string]any
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

type InteractionUpsert struct {
	WorkspaceID      string
	AgentSessionID   string
	RequestID        string
	TurnID           string
	Kind             string
	Status           string
	ToolName         string
	Input            map[string]any
	Output           map[string]any
	Metadata         map[string]any
	OccurredAtUnixMS int64
}

type InteractionTransitionResult string

const (
	InteractionTransitionApplied        InteractionTransitionResult = "applied"
	InteractionTransitionAlreadyApplied InteractionTransitionResult = "already_applied"
	InteractionTransitionConflict       InteractionTransitionResult = "conflict"
)

type ListSessionInteractionsInput struct {
	WorkspaceID    string
	AgentSessionID string
	// Status filters by interaction status when non-empty.
	Status string
}

// StaleTurnSettlement identifies one turn that startup reconciliation
// force-settled with outcome interrupted.
type StaleTurnSettlement struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
}

type SessionStateReport struct {
	WorkspaceID       string
	AgentSessionID    string
	Origin            string
	UserID            string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	Model             string
	Settings          map[string]any
	RuntimeContext    map[string]any
	Cwd               string
	Title             string
	Status            string
	CurrentPhase      string
	LastError         string
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	EndedAtUnixMS     int64
}

type StateReportResult struct {
	Accepted         bool
	StateApplied     bool
	LastEventUnixMS  int64
	RequestBodyBytes int
	Session          Session
}

type SessionMessageReport struct {
	WorkspaceID    string
	AgentSessionID string
	Origin         string
	Provider       string
	Messages       []MessageUpdate
}

type MessageUpdate struct {
	MessageID         string
	TurnID            string
	Role              string
	Kind              string
	Status            string
	ContentDelta      string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
}

type MessageReportResult struct {
	AcceptedCount    int
	LatestVersion    uint64
	Messages         []Message
	RequestBodyBytes int
}

type Message struct {
	ID                uint64
	AgentSessionID    string
	MessageID         string
	Version           uint64
	TurnID            string
	Role              string
	Kind              string
	Status            string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type MessagePage struct {
	AgentSessionID string
	Messages       []Message
	LatestVersion  uint64
	HasMore        bool
}
