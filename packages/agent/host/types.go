package agenthost

import storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"

// SessionRef identifies one canonical session without carrying host transport
// or authorization state.
type SessionRef struct {
	WorkspaceID    string
	AgentSessionID string
}

// InteractionRef identifies one canonical interaction. Provider request IDs
// are transport-local correlation values and are only unique within the Turn
// that owns them.
type InteractionRef struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	RequestID      string
}

// SessionInteractionSnapshot is the canonical interaction state for the
// session's latest turn. PendingInteractions is derived from Interactions so a
// consumer never observes actionable state from a different turn or read.
type SessionInteractionSnapshot struct {
	Interactions        []storesqlite.Interaction
	PendingInteractions []storesqlite.Interaction
}

// SessionMessageQuery selects one page of canonical message snapshots. Session
// identity comes from SessionRef so transport adapters cannot accidentally
// query a different session through duplicated identity fields.
type SessionMessageQuery struct {
	MessageID     string
	TurnID        string
	AfterVersion  uint64
	BeforeVersion uint64
	Limit         int
	Order         storesqlite.MessageOrder
}

// SessionTurnCursor is the stable position immediately before a descending
// session-Turn page.
type SessionTurnCursor = storesqlite.SessionTurnCursor

// SessionTurnSummary is the canonical metadata needed to discover and render
// one Turn without loading message or provider payloads.
type SessionTurnSummary = storesqlite.SessionTurnSummary

// SessionTurnSummaryPage is one newest-first page of canonical Turn metadata.
type SessionTurnSummaryPage = storesqlite.SessionTurnSummaryPage

// SessionTurnQuery selects one bounded, newest-first page of canonical Turns.
// Session identity comes from SessionRef.
type SessionTurnQuery struct {
	Before *SessionTurnCursor
	Limit  int
}

type ComposerSettings struct {
	Model            string
	ModelPlanID      string
	PermissionModeID string
	PlanMode         bool
	// BrowserUse is tri-state: nil means "use the default" (on), so the
	// composer can distinguish an explicit opt-out from an unset value.
	BrowserUse *bool
	// ComputerUse is tri-state: nil means "use the default" (on), so the
	// composer can distinguish an explicit opt-out from an unset value.
	ComputerUse            *bool
	ReasoningEffort        string
	Speed                  string
	ConversationDetailMode string
}

type ComposerSettingsPatch struct {
	Model            *string
	PermissionModeID *string
	PlanMode         *bool
	BrowserUse       *bool
	ComputerUse      *bool
	ReasoningEffort  *string
	Speed            *string
}

// ProviderRuntimeSession is an adapter observation. Canonical Session, Turn,
// and Interaction rows remain authoritative for durable lifecycle state.
type ProviderRuntimeSession struct {
	ID                      string
	WorkspaceID             string
	UserID                  string
	AgentTargetID           string
	Provider                string
	ProviderSessionID       string
	Resumable               bool
	Cwd                     string
	Env                     []string
	ProviderTargetRef       map[string]any
	Settings                *ComposerSettings
	RuntimeContext          map[string]any
	Status                  string
	TurnLifecycle           *TurnLifecycle
	SubmitAvailability      *SubmitAvailability
	Visible                 bool
	Title                   string
	InitialTitleEstablished bool
	Provisional             bool
	LastError               string
	PinnedAtUnixMS          int64
	CreatedAtUnixMS         int64
	UpdatedAtUnixMS         int64
}

type ForkSessionInput struct {
	WorkspaceID          string
	SourceAgentSessionID string
	TargetAgentSessionID string
	RequestID            string
	Point                SessionForkPoint
	// ThroughTurnID is a temporary source-compatibility alias. New callers
	// must use Point so adding whole-session mode does not reopen Host APIs.
	ThroughTurnID string
}

type SessionForkPointKind string

const (
	SessionForkPointThroughTurn SessionForkPointKind = "through_turn"
)

type SessionForkPoint struct {
	Kind   SessionForkPointKind
	TurnID string
}

type ForkSessionResult struct {
	Operation storesqlite.SessionForkOperation
	Session   storesqlite.Session
	Lineage   *storesqlite.SessionForkLineage
}

type SessionForkCapabilityInput struct {
	WorkspaceID          string
	SourceAgentSessionID string
}

type SessionForkCapabilities struct {
	FullSession         bool
	ThroughTurn         bool
	ThroughTurnIDs      []string
	ThroughTurnIDsKnown bool
}

// SessionForkTargetContext freezes the host-owned runtime context that the
// canonical target session will receive. Provider-native thread state is
// separate and remains owned by SessionForkRuntime.
type SessionForkTargetContext struct {
	Cwd            string
	RuntimeContext map[string]any
}

type SessionForkDriverDescriptor struct {
	Kind             string
	Version          string
	StateBindingMode SessionForkStateBindingMode
	// DeterministicTargetSessionID guarantees that ForkSession honors
	// TargetProviderSessionID and that repeating the same input reconciles or
	// creates that one provider child instead of allocating another identity.
	DeterministicTargetSessionID bool
	FullSession                  bool
	ThroughTurn                  bool
	ThroughProviderTurnIDs       []string
	ThroughProviderTurnIDsKnown  bool
}

type RuntimeSessionForkInput struct {
	Source                  ProviderRuntimeSession
	SourceProviderTurnID    string
	SourceProviderTurnIDs   []string
	TargetProviderSessionID string
	TargetTitle             string
	RequestID               string
	Driver                  SessionForkDriverDescriptor
}

type SessionForkDeliveryDisposition string

const (
	SessionForkDeliveryNotStarted SessionForkDeliveryDisposition = "not_started"
	SessionForkDeliveryRejected   SessionForkDeliveryDisposition = "rejected"
	SessionForkDeliveryUnknown    SessionForkDeliveryDisposition = "unknown"
	SessionForkDeliveryAccepted   SessionForkDeliveryDisposition = "accepted"
)

type RuntimeSessionForkResult struct {
	ProviderSessionID     string
	TargetProviderTurnIDs []string
	StateBindingMode      SessionForkStateBindingMode
	StateBindingReceipt   string
	DeliveryDisposition   SessionForkDeliveryDisposition
}

type SessionForkStateBindingMode string

const (
	SessionForkStateBindingHostCopy      SessionForkStateBindingMode = "host_copy"
	SessionForkStateBindingProviderOwned SessionForkStateBindingMode = "provider_owned"
)

// SessionForkProviderStateBinding describes the provider-local durable state
// that must become independently discoverable from the target Tutti session's
// runtime namespace before the canonical child can be committed.
type SessionForkProviderStateBinding struct {
	WorkspaceID             string
	Provider                string
	SourceAgentSessionID    string
	TargetAgentSessionID    string
	SourceProviderSessionID string
	TargetProviderSessionID string
}

type RuntimeStartInput struct {
	WorkspaceID             string
	AgentSessionID          string
	AgentTargetID           string
	Provider                string
	Cwd                     string
	Env                     []string
	Title                   string
	InitialTitleEstablished bool
	PermissionModeID        string
	Model                   string
	PlanMode                bool
	BrowserUse              *bool
	ComputerUse             *bool
	ProviderTargetRef       map[string]any
	RuntimeContext          map[string]any
	ReasoningEffort         string
	Speed                   string
	ConversationDetailMode  string
	Visible                 *bool
	Provisional             bool
}

type RuntimeResumeInput struct {
	WorkspaceID            string
	AgentSessionID         string
	AgentTargetID          string
	Provider               string
	ProviderSessionID      string
	Resumable              bool
	Cwd                    string
	Env                    []string
	Title                  string
	Status                 string
	Settings               ComposerSettings
	CreatedAtUnixMS        int64
	UpdatedAtUnixMS        int64
	Visible                *bool
	RuntimeContext         map[string]any
	ProviderTargetRef      map[string]any
	Metadata               storesqlite.SessionMetadata
	InternalRuntimeContext map[string]any
	// RecreateIfMissing lets the runtime start a fresh provider session in place
	// when the existing one can't be restored locally (imported conversations),
	// instead of surfacing a non-recoverable restore error.
	RecreateIfMissing bool
}

type RuntimeExecInput struct {
	WorkspaceID                     string
	AgentSessionID                  string
	TurnID                          string
	ClientSubmitID                  string
	CanonicalSubmitOccurredAtUnixMS int64
	CapabilityRefs                  []CapabilityReference
	Content                         []PromptContentBlock
	DisplayPrompt                   string
	InitialTitle                    string
	InitialTitleBase                string
	Metadata                        map[string]any
	Guidance                        bool
	HistoryReplacement              bool
	RequireProviderAcceptance       bool
	TuttiModeSnapshot               *TuttiModeTurnSnapshot
}

type CapabilityReference struct {
	Capability string
	Source     string
}

// TuttiModeTurnSnapshot is the immutable activation revision observed by one
// turn. It is an execution input, not a reconstruction from capability refs.
const TuttiModePreferenceVersionEffectSpeed = 1

type TuttiModeTurnSnapshot struct {
	ActivationID      string
	RevisionID        string
	Revision          int64
	State             string
	Source            string
	PreferenceVersion int
	Effect            int
	Speed             int
	// OrchestrationIntensity is the legacy single-axis alias of Effect.
	//
	// Deprecated: use Effect and Speed with PreferenceVersion set to
	// TuttiModePreferenceVersionEffectSpeed.
	OrchestrationIntensity int
}

type RuntimeExecResult struct {
	AgentSessionID     string
	Status             string
	TurnID             string
	Accepted           bool
	ProviderDispatch   RuntimeProviderDispatchResult
	SessionStatus      string
	TurnLifecycle      TurnLifecycle
	SubmitAvailability SubmitAvailability
}

type RuntimeDispatchDisposition string

const (
	RuntimeDispatchDispositionApplied        RuntimeDispatchDisposition = "applied"
	RuntimeDispatchDispositionRejected       RuntimeDispatchDisposition = "rejected"
	RuntimeDispatchDispositionNotDispatched  RuntimeDispatchDisposition = "not_dispatched"
	RuntimeDispatchDispositionOutcomeUnknown RuntimeDispatchDisposition = "outcome_unknown"
)

type RuntimeAcceptanceSource string

const (
	RuntimeAcceptanceSourceTurnStartResponse RuntimeAcceptanceSource = "turn_start_response"
	RuntimeAcceptanceSourceHistoryRead       RuntimeAcceptanceSource = "history_read"
)

// RuntimeProviderAcceptanceReceipt is positive provider evidence that a
// replacement turn crossed the provider delivery boundary.
type RuntimeProviderAcceptanceReceipt struct {
	ProviderSessionID string
	ProviderTurnID    string
	Source            RuntimeAcceptanceSource
}

// RuntimeProviderDispatchResult separates an explicit provider outcome from a
// transport failure whose effect is unknown. Acceptance is present only when
// the provider supplied positive evidence for the dispatched turn.
type RuntimeProviderDispatchResult struct {
	Disposition RuntimeDispatchDisposition
	Acceptance  *RuntimeProviderAcceptanceReceipt
}

type RuntimeHistoryTurn struct {
	ID                  string
	Status              string
	ClientUserMessageID string
}

// RuntimeHistorySnapshot is the provider runtime's authoritative effective
// thread membership and ordering. Canonical history revisions intentionally
// stay outside this provider observation.
type RuntimeHistorySnapshot struct {
	ProviderSessionID string
	Turns             []RuntimeHistoryTurn
}

type RuntimeHistoryInput struct {
	WorkspaceID    string
	AgentSessionID string
	Provider       string
}

type RuntimeHistoryMutationResult struct {
	Disposition RuntimeDispatchDisposition
	Snapshot    *RuntimeHistorySnapshot
}

// RuntimeProviderTurnAcceptanceInput carries an authoritative provider-history
// observation back through the normal durable activity projection. It is not a
// dispatch command and must never start or retry a provider turn.
type RuntimeProviderTurnAcceptanceInput struct {
	WorkspaceID               string
	AgentSessionID            string
	Provider                  string
	RootTurnID                string
	ExpectedProviderSessionID string
	ExpectedProviderTurnID    string
	ClientUserMessageID       string
}

type RuntimeSubmitProvenanceInput struct {
	WorkspaceID                     string
	AgentSessionID                  string
	TurnID                          string
	ClientSubmitID                  string
	CanonicalSubmitOccurredAtUnixMS int64
	Content                         []PromptContentBlock
	DisplayPrompt                   string
	Guidance                        bool
}

type CompletedCommand struct {
	Kind   string
	Status string
}

type SubmitAvailability struct {
	State  string
	Reason string
}

type TurnLifecycle struct {
	ActiveTurnID     *string
	Phase            string
	Settling         bool
	Outcome          *string
	CompletedCommand *CompletedCommand
}

type RuntimeCancelInput struct {
	WorkspaceID        string
	RootAgentSessionID string
	Targets            []RuntimeCancelTarget
	Reason             string
}

type RuntimeCancelTarget struct {
	AgentSessionID string
	TurnID         string
}

type RuntimeCancelResult struct {
	AgentSessionID   string
	Canceled         bool
	TargetAbsent     bool
	ConfirmedTargets []RuntimeCancelTarget
}

type RuntimeCloseInput struct {
	WorkspaceID    string
	AgentSessionID string
}

type RuntimeSubmitInteractiveInput struct {
	WorkspaceID        string
	RootAgentSessionID string
	AgentSessionID     string
	TurnID             string
	RequestID          string
	Action             string
	OptionID           string
	Payload            map[string]any
}

type RuntimeSubmitInteractiveResult struct {
	Disposition RuntimeInteractiveDisposition
}

type RuntimeInteractiveDisposition string

const (
	RuntimeInteractiveDispositionPending     RuntimeInteractiveDisposition = "pending"
	RuntimeInteractiveDispositionResolving   RuntimeInteractiveDisposition = "resolving"
	RuntimeInteractiveDispositionAnswered    RuntimeInteractiveDisposition = "answered"
	RuntimeInteractiveDispositionSuperseded  RuntimeInteractiveDisposition = "superseded"
	RuntimeInteractiveDispositionInterrupted RuntimeInteractiveDisposition = "interrupted"
	RuntimeInteractiveDispositionUnknown     RuntimeInteractiveDisposition = "unknown"
)

type RuntimeUpdateSettingsInput struct {
	WorkspaceID    string
	AgentSessionID string
	Settings       ComposerSettingsPatch
}

type RuntimeSetVisibleInput struct {
	WorkspaceID    string
	AgentSessionID string
	Visible        bool
}

type RuntimeSetTitleInput struct {
	WorkspaceID    string
	AgentSessionID string
	Title          string
}

type PromptContentBlock struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	MimeType     string `json:"mimeType,omitempty"`
	Data         string `json:"data,omitempty"`
	URL          string `json:"url,omitempty"`
	AttachmentID string `json:"attachmentId,omitempty"`
	Name         string `json:"name,omitempty"`
	Path         string `json:"path,omitempty"`
}

type PromptAttachment struct {
	AttachmentID string
	MimeType     string
	Data         string
}

type RailPlacementKind string

const (
	RailPlacementKindConversations RailPlacementKind = "conversations"
	RailPlacementKindProject       RailPlacementKind = "project"
)

// RailPlacement is the caller-selected canonical conversation-rail identity
// for a newly created session. SectionKey is opaque to Host and is persisted
// exactly; ProjectPath is the caller's logical project path, not a prepared
// runtime or owner-host path.
type RailPlacement struct {
	Version     int               `json:"version"`
	Kind        RailPlacementKind `json:"kind"`
	ProjectPath string            `json:"projectPath,omitempty"`
	SectionKey  string            `json:"sectionKey"`
}

// CreateSessionInput is the provider-neutral create contract. Adapter-only
// import paths, workspace resolution, identity, and transport state are not
// part of this type.
type CreateSessionInput struct {
	AgentSessionID       string
	AgentTargetID        string
	Provider             string
	InitialContent       []PromptContentBlock
	InitialDisplayPrompt string
	Metadata             map[string]any
	// ClientSubmitID is the caller-owned idempotency identity for the optional
	// initial turn and overrides legacy Metadata["clientSubmitId"].
	ClientSubmitID         string
	TurnID                 string
	CapabilityRefs         []CapabilityReference
	TuttiModeSnapshot      *TuttiModeTurnSnapshot
	Title                  *string
	Cwd                    *string
	PermissionModeID       *string
	Model                  *string
	PlanMode               *bool
	BrowserUse             *bool
	ComputerUse            *bool
	ProviderTargetRef      map[string]any
	ReasoningEffort        *string
	RuntimeContext         map[string]any
	Speed                  *string
	ConversationDetailMode string
	Visible                *bool
	RailPlacement          *RailPlacement
}

type SendInput struct {
	CapabilityRefs    []CapabilityReference
	TurnID            string
	TuttiModeSnapshot *TuttiModeTurnSnapshot
	Content           []PromptContentBlock
	DisplayPrompt     string
	Metadata          map[string]any
	// ClientSubmitID is the caller-owned idempotency identity. When present it
	// overrides any legacy clientSubmitId value carried in Metadata.
	ClientSubmitID string
	Guidance       bool
}

type SubmitInteractiveInput struct {
	Action   *string
	OptionID *string
	Payload  map[string]any
}

type SubmitPlanDecisionInput struct {
	PromptKind     string
	Action         string
	IdempotencyKey string
}

type EditRetryRecoveryAction string

const (
	EditRetryRecoveryActionReconcile        EditRetryRecoveryAction = "reconcile"
	EditRetryRecoveryActionRetryReplacement EditRetryRecoveryAction = "retry_replacement"
)

// EditRetryReasonCode is a stable, coarse Host-owned classification. Provider
// codes and diagnostics must not be exposed or persisted through this type.
type EditRetryReasonCode string

const (
	EditRetryReasonCodeProviderUnsupported        EditRetryReasonCode = "provider_unsupported"
	EditRetryReasonCodeTurnNotFound               EditRetryReasonCode = "turn_not_found"
	EditRetryReasonCodeTurnNotLatest              EditRetryReasonCode = "turn_not_latest"
	EditRetryReasonCodeTurnNotSettled             EditRetryReasonCode = "turn_not_settled"
	EditRetryReasonCodeHistoryRevisionConflict    EditRetryReasonCode = "history_revision_conflict"
	EditRetryReasonCodeOperationConflict          EditRetryReasonCode = "operation_conflict"
	EditRetryReasonCodeRecoveryRequired           EditRetryReasonCode = "recovery_required"
	EditRetryReasonCodeProviderOutcomeUnknown     EditRetryReasonCode = "provider_outcome_unknown"
	EditRetryReasonCodeReplacementNotProvenAbsent EditRetryReasonCode = "replacement_not_proven_absent"
)

type EditRetryInput struct {
	EditedText              string
	ClientOperationID       string
	ExpectedHistoryRevision uint64
}

type EditRetryState string

const (
	EditRetryStatePrepared         EditRetryState = "prepared"
	EditRetryStateRollingBack      EditRetryState = "rolling_back"
	EditRetryStateResendPending    EditRetryState = "resend_pending"
	EditRetryStateRecoveryRequired EditRetryState = "recovery_required"
	EditRetryStateCompleted        EditRetryState = "completed"
)

type EditRetryResult struct {
	OperationID       string
	State             EditRetryState
	RetractedTurnID   string
	ReplacementTurnID string
	HistoryRevision   uint64
	ReasonCode        EditRetryReasonCode
}

type EditRetryAvailability struct {
	Supported        bool
	Eligible         bool
	TurnID           string
	HistoryRevision  uint64
	RecoveryState    EditRetryState
	OperationID      string
	AvailableActions []EditRetryRecoveryAction
	ReasonCode       EditRetryReasonCode
}

type CancelTurnInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	Reason         string
	// RequireLive forbids internal cleanup from reconnecting an offline
	// provider merely to deliver cancellation. The durable Turn remains
	// pending until a live connection can report its authoritative terminal.
	RequireLive bool
}

type CancelState string

const (
	CancelStateNotFound       CancelState = "not_found"
	CancelStateAlreadySettled CancelState = "already_settled"
	CancelStateRequested      CancelState = "cancel_requested"
	CancelStateSettled        CancelState = "settled"
)

// CancelTurnResult keeps durable intent acceptance, provider confirmation,
// and canonical settlement separate. Adapters must not infer a terminal
// canceled turn merely from IntentAccepted.
type CancelTurnResult struct {
	Canonical         storesqlite.Session
	Turn              *storesqlite.Turn
	Operation         storesqlite.RuntimeOperation
	State             CancelState
	IntentAccepted    bool
	ProviderConfirmed bool
	Settled           bool
	Outcome           string
}

type SubmitInteractiveResult struct {
	Canonical   storesqlite.Session
	Operation   storesqlite.RuntimeOperation
	Disposition RuntimeInteractiveDisposition
}

type UpdateTitleInput struct {
	WorkspaceID    string
	AgentSessionID string
	Title          string
}

type UpdateSettingsInput struct {
	WorkspaceID    string
	AgentSessionID string
	Settings       ComposerSettingsPatch
}

type UpdatePinInput struct {
	WorkspaceID    string
	AgentSessionID string
	Pinned         bool
}

type CreateSessionResult struct {
	Session     ProviderRuntimeSession
	Canonical   storesqlite.Session
	TurnID      string
	Kind        string
	GoalControl *GoalControlResult
}

type SendInputResult struct {
	Session            ProviderRuntimeSession
	Canonical          storesqlite.Session
	Turn               *storesqlite.Turn
	TurnID             string
	TurnLifecycle      TurnLifecycle
	SubmitAvailability SubmitAvailability
	Kind               string
	GoalControl        *GoalControlResult
}

type UpdateTitleResult struct {
	Session   ProviderRuntimeSession
	Canonical storesqlite.Session
}

// GetSessionResult carries canonical truth together with an optional live
// runtime observation. Adapters remain responsible for transport DTOs and
// presentation-only derived fields.
type GetSessionResult struct {
	Session   ProviderRuntimeSession
	Canonical storesqlite.Session
	Live      bool
}

type UpdateSettingsResult struct {
	Session   ProviderRuntimeSession
	Canonical storesqlite.Session
	Live      bool
}

type UpdatePinResult struct {
	Session   ProviderRuntimeSession
	Canonical storesqlite.Session
	Live      bool
}

type DeleteSessionResult struct {
	Deleted          bool
	RuntimeClosed    bool
	CanonicalRemoved bool
	CleanupFailed    bool
}

type DeleteSessionsInput struct {
	WorkspaceID string
	SessionIDs  []string
}

// DeleteSessionsPlan is the exact canonical deletion closure resolved by Host.
// Adapters may inspect it through SessionDeletionGuard but must not expand or
// replace it with product-specific ownership semantics.
type DeleteSessionsPlan struct {
	WorkspaceID string
	SessionIDs  []string
}

type DeleteSessionsResult struct {
	RemovedSessionIDs []string
	RemovedSessions   int
	RemovedMessages   int
	RuntimeClosedIDs  []string
	CleanupFailedIDs  []string
}

// DeleteSessionsReport describes the terminal outcome of one admitted plan.
// Err is non-nil when that attempt failed, including when the canonical closure
// changed and Host must replan before admitting another attempt.
type DeleteSessionsReport struct {
	Plan   DeleteSessionsPlan
	Result DeleteSessionsResult
	Err    error
}

type ClearSessionsResult = DeleteSessionsResult

type PurgeDeletedSessionsInput struct {
	CutoffUnixMS    int64
	MaxSessions     int
	MaxPayloadBytes int64
}

type PurgeDeletedSessionsResult struct {
	Sessions        []storesqlite.PurgedSession
	RemovedMessages int
	PayloadBytes    int64
	HasMore         bool
}

type RuntimeGoalControlInput struct {
	WorkspaceID        string
	AgentSessionID     string
	Action             string
	Objective          string
	OperationID        string
	GoalRevision       int64
	RepairEpoch        int64
	SubmissionMetadata map[string]any
	// RequireLive forbids a background worker from reconnecting an offline
	// provider merely to deliver this control.
	RequireLive bool
}

type RuntimeGoalControlResult struct {
	AgentSessionID string
	Goal           map[string]any
	Evidence       map[string]any
	ProviderPhase  string
}

type RuntimeGoalReconcileResult struct {
	AgentSessionID string
	Goal           map[string]any
	Evidence       map[string]any
}

type RuntimeGoalRecoveryPolicy struct {
	QuerySupported        bool
	ReplaySetAfterRestart bool
}

type RuntimeGoalGenerationFenceInput struct {
	WorkspaceID       string
	AgentSessionID    string
	TargetOperationID string
	TargetRevision    int64
	TargetRepairEpoch int64
	Reason            string
	RequireLive       bool
}

type GoalControlInput struct {
	WorkspaceID    string
	AgentSessionID string
	Action         string
	Objective      string
	// ClientSubmitID is the caller-stable identity for one semantic mutation.
	// It overrides the legacy SubmissionMetadata["clientSubmitId"] value and
	// makes retries idempotent across Host process restarts.
	ClientSubmitID     string
	SubmissionMetadata map[string]any
	// ExpectedRevision conditionally applies this control only while the exact
	// Goal generation is still current. Zero preserves ordinary controls.
	ExpectedRevision int64
}

type GoalControlResult struct {
	Canonical   storesqlite.Session
	Goal        map[string]any
	OperationID string
	GoalState   *storesqlite.SessionGoalState
}

type GoalStateResult struct {
	Canonical storesqlite.Session
	State     storesqlite.SessionGoalState
}

type FenceGoalGenerationInput struct {
	WorkspaceID       string
	AgentSessionID    string
	TargetOperationID string
	ClientSubmitID    string
	Reason            string
}

type FenceGoalGenerationResult struct {
	Fence          storesqlite.GoalGenerationFence
	IntentAccepted bool
	Settled        bool
}

type GoalReconcileRequiredInput struct {
	WorkspaceID         string
	AgentSessionID      string
	RequestID           string
	ProviderTurnID      string
	Reason              string
	FenceMode           string
	ExpectedOperationID string
	ExpectedRevision    int64
	ExpectedRepairEpoch int64
	QuiesceSucceeded    bool
	QuiesceError        string
}
