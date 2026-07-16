// Package storesqlite provides an embeddable SQLite persistence layer for
// agent activity (sessions, messages, rail sections, generated files) and
// agent targets. It operates on an injected *sql.DB, keeps its own schema
// migration ledger, and makes no assumptions about the host schema beyond
// the tables it owns; host concerns (workspace existence, project paths,
// target normalization) are injected through Options.
package storesqlite

import (
	"context"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// Repository is the public persistence contract for agent activity.
// All methods are scoped by a host-defined workspace ID.
type Repository interface {
	ClearSessions(context.Context, string) (ClearSessionsResult, error)
	DeleteSession(context.Context, string, string) (bool, error)
	DeleteSessionsBatch(context.Context, DeleteSessionsBatchInput) (DeleteSessionsBatchResult, error)
	GetSession(context.Context, string, string) (Session, bool, error)
	ListChildSessions(context.Context, string, string) ([]Session, error)
	SessionDeleted(context.Context, string, string) (bool, error)
	GetLatestTurn(context.Context, string, string) (Turn, bool, error)
	GetTurn(context.Context, string, string, string) (Turn, bool, error)
	ListSessionInteractions(context.Context, ListSessionInteractionsInput) ([]Interaction, error)
	ListLatestTurns(context.Context, string, []string) (map[string]Turn, error)
	ListLatestTurnInteractions(context.Context, string, []string) (map[string][]Interaction, error)
	ListTurnsBySession(context.Context, string, map[string]string) (map[string]Turn, error)
	ListPendingInteractionsBySession(context.Context, string, []string) (map[string][]Interaction, error)
	ListSessionSection(context.Context, ListSessionSectionInput) (SessionSectionPage, bool, error)
	ListSessionSections(context.Context, ListSessionSectionsInput) (SessionSectionsPage, bool, error)
	ListSessionSectionDeletionCandidates(context.Context, ListSessionSectionDeletionCandidatesInput) (SessionSectionDeletionCandidates, bool, error)
	ListSessionTurns(context.Context, string, string) ([]Turn, error)
	ListSessions(context.Context, string) ([]Session, bool, error)
	ListWorkspaceGeneratedFileTurns(context.Context, ListWorkspaceGeneratedFileTurnsInput) (GeneratedFileTurnList, bool, error)
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
	UpdateSessionSettings(context.Context, string, string, string, map[string]any) (Session, bool, error)
	UpdateSessionTitle(context.Context, string, string, string) (Session, bool, error)
}

// GoalProvenanceLedger is a narrow optional persistence capability. It stays
// separate from Repository so read-only/custom activity repositories do not
// need to implement provider-specific Goal attribution.
type GoalProvenanceLedger interface {
	BindGoalProvenance(context.Context, BindGoalProvenanceInput) (GoalProvenanceBinding, error)
	LookupGoalProvenance(context.Context, LookupGoalProvenanceInput) (GoalProvenanceBinding, bool, error)
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
	// AfterVersion and BeforeVersion are per-session change cursors. Current
	// message snapshots may skip cursor values when the same message is updated.
	AfterVersion  uint64
	BeforeVersion uint64
	Limit         int
	Order         MessageOrder
}

type ListWorkspaceGeneratedFileTurnsInput struct {
	WorkspaceID string
	SectionKey  string
}

type GeneratedFileTurnChange struct {
	Path   string
	Change string
}

type GeneratedFileTurn struct {
	AgentSessionID  string
	AgentTargetID   string
	TurnID          string
	CWD             string
	RailSectionKind string
	RailProjectPath string
	SettledAtUnixMS int64
	Changes         []GeneratedFileTurnChange
}

type GeneratedFileTurnList struct {
	WorkspaceID string
	Turns       []GeneratedFileTurn
}

type ListSessionSectionInput struct {
	WorkspaceID          string
	SectionKey           string
	AgentTargetID        string
	CursorSortTimeUnixMS int64
	CursorSessionID      string
	Limit                int
}

// ListSessionSectionsInput describes the first-page bootstrap for every rail
// section in one workspace query. SectionKeys includes the synthetic pinned
// page key when the caller needs pinned conversations.
type ListSessionSectionsInput struct {
	WorkspaceID     string
	SectionKeys     []string
	AgentTargetID   string
	LimitPerSection int
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

type SessionSectionsPage struct {
	WorkspaceID string
	Sections    []SessionSectionPage
}

type Session struct {
	ID                     string
	WorkspaceID            string
	Kind                   string
	RootAgentSessionID     string
	RootTurnID             string
	ParentAgentSessionID   string
	ParentTurnID           string
	ParentToolCallID       string
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
	RailSectionKey         string
	Title                  string
	// ActiveTurnID is the protocol v2 turn reference: the id of the turn
	// currently in flight, empty when the session is idle.
	ActiveTurnID string
	// MessageVersion is the latest accepted per-session message change cursor.
	// It is a high-water mark, not a count of current message rows.
	MessageVersion  uint64
	LastEventUnixMS int64
	StartedAtUnixMS int64
	EndedAtUnixMS   int64
	PinnedAtUnixMS  int64
	CreatedAtUnixMS int64
	UpdatedAtUnixMS int64
}

const (
	SessionKindRoot  = canonical.SessionKindRoot
	SessionKindChild = canonical.SessionKindChild
)

// ActivityStateReport persists the session projection and its optional v2
// turn/interaction entities as one atomic unit. Child entities must identify
// the same workspace and session as Session.
type ActivityStateReport struct {
	Session          SessionStateReport
	Turn             *TurnTransition
	RootProviderTurn *RootProviderTurnTransition
	Interaction      *InteractionUpsert
}

type ActivityStateReportResult struct {
	State             StateReportResult
	Turn              Turn
	TurnAccepted      bool
	RootTurn          Turn
	RootTurnAccepted  bool
	Interaction       Interaction
	InteractionResult InteractionTransitionResult
}

// Closed protocol v2 turn phase vocabulary. The storage CHECK constraints
// mirror this list; keep both in sync with the openapi WorkspaceAgentTurnPhase
// enum.
const (
	TurnPhaseSubmitted = canonical.TurnPhaseSubmitted
	TurnPhaseRunning   = canonical.TurnPhaseRunning
	TurnPhaseWaiting   = canonical.TurnPhaseWaiting
	TurnPhaseSettling  = canonical.TurnPhaseSettling
	TurnPhaseSettled   = canonical.TurnPhaseSettled
)

// Closed protocol v2 turn outcome vocabulary; mirrors the openapi
// WorkspaceAgentTurnOutcome enum.
const (
	TurnOutcomeCompleted   = canonical.TurnOutcomeCompleted
	TurnOutcomeFailed      = canonical.TurnOutcomeFailed
	TurnOutcomeCanceled    = canonical.TurnOutcomeCanceled
	TurnOutcomeInterrupted = canonical.TurnOutcomeInterrupted

	TurnOriginUserPrompt        = canonical.TurnOriginUserPrompt
	TurnOriginGoalArm           = canonical.TurnOriginGoalArm
	TurnOriginGoalContinuation  = canonical.TurnOriginGoalContinuation
	TurnOriginProviderInitiated = canonical.TurnOriginProviderInitiated
	TurnOriginLegacyUnknown     = canonical.TurnOriginLegacyUnknown
)

// Turn is the protocol v2 execution entity inside either a root or child
// session. It may originate from a user prompt, Goal control, or an explicit
// provider-initiated interaction and carries both Goal provenance and the
// root-provider completion projection.
type Turn struct {
	WorkspaceID                            string
	AgentSessionID                         string
	TurnID                                 string
	Phase                                  string
	Outcome                                string
	ErrorMessage                           string
	ErrorCode                              string
	FileChanges                            map[string]any
	CompletedCommandKind                   string
	CompletedCommandStatus                 string
	Backfilled                             bool
	StartedAtUnixMS                        int64
	SettledAtUnixMS                        int64
	CreatedAtUnixMS                        int64
	UpdatedAtUnixMS                        int64
	Origin                                 string
	SourceGoalOperationID                  string
	SourceGoalRevision                     int64
	SourceGoalRepairEpoch                  int64
	RootProviderTurnID                     string
	RootProviderTurnPhase                  string
	RootProviderTurnOutcome                string
	RootProviderTurnErrorMessage           string
	RootProviderTurnErrorCode              string
	RootProviderTurnCompletedCommandKind   string
	RootProviderTurnCompletedCommandStatus string
	RootProviderTurnUpdatedAtUnixMS        int64
}

const (
	RootProviderTurnPhaseRunning   = canonical.RootProviderTurnPhaseRunning
	RootProviderTurnPhaseCompleted = canonical.RootProviderTurnPhaseCompleted
)

type RootProviderTurnTransition struct {
	WorkspaceID            string
	RootAgentSessionID     string
	RootTurnID             string
	ProviderTurnID         string
	Phase                  string
	Outcome                string
	ErrorMessage           string
	ErrorCode              string
	CompletedCommandKind   string
	CompletedCommandStatus string
	OccurredAtUnixMS       int64
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
	Origin                 string
	SourceGoalOperationID  string
	SourceGoalRevision     int64
	SourceGoalRepairEpoch  int64
	StartedAtUnixMS        int64
	SettledAtUnixMS        int64
	OccurredAtUnixMS       int64
}

// Closed protocol v2 interaction vocabulary; mirrors the openapi
// WorkspaceAgentInteractionKind / WorkspaceAgentInteractionStatus enums.
const (
	InteractionKindApproval = canonical.InteractionKindApproval
	InteractionKindQuestion = canonical.InteractionKindQuestion
	InteractionKindPlan     = canonical.InteractionKindPlan

	InteractionStatusPending    = canonical.InteractionStatusPending
	InteractionStatusAnswered   = canonical.InteractionStatusAnswered
	InteractionStatusSuperseded = canonical.InteractionStatusSuperseded
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
	WorkspaceID          string
	AgentSessionID       string
	Kind                 string
	RootAgentSessionID   string
	RootTurnID           string
	ParentAgentSessionID string
	ParentTurnID         string
	ParentToolCallID     string
	Origin               string
	UserID               string
	AgentTargetID        string
	Provider             string
	ProviderSessionID    string
	Model                string
	Settings             map[string]any
	RuntimeContext       map[string]any
	Cwd                  string
	Title                string
	Status               string
	CurrentPhase         string
	LastError            string
	OccurredAtUnixMS     int64
	StartedAtUnixMS      int64
	EndedAtUnixMS        int64
	CreatedAtUnixMS      int64
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
	// HistoricalImport is an internal-only compatibility boundary for
	// read-only external transcript imports that predate Turn identities. It
	// must never be populated from runtime/API report payloads.
	HistoricalImport bool
	Messages         []MessageUpdate
}

type MessageUpdate struct {
	MessageID         string
	TurnID            string
	Role              string
	Kind              string
	Status            string
	Semantics         *MessageSemantics
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
	ID             uint64
	AgentSessionID string
	MessageID      string
	// Version is a per-session change cursor for this mutable snapshot. Updating
	// the same MessageID assigns a newer version, so current rows may have gaps.
	Version           uint64
	TurnID            string
	Role              string
	Kind              string
	Status            string
	Semantics         *MessageSemantics
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type MessageSemantics struct {
	UserVisibleAssistantResponse bool   `json:"userVisibleAssistantResponse,omitempty"`
	TurnSettling                 bool   `json:"turnSettling,omitempty"`
	NoticeCommand                string `json:"noticeCommand,omitempty"`
	NoticeCommandStatus          string `json:"noticeCommandStatus,omitempty"`
}

type MessagePage struct {
	AgentSessionID string
	Messages       []Message
	// LatestVersion is the largest cursor delivered by this page, or the input
	// AfterVersion when an ascending page contains no newer snapshots.
	LatestVersion uint64
	HasMore       bool
}
