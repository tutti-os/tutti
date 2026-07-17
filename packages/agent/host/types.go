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
	Cwd                     string
	Env                     []string
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
	WorkspaceID       string
	AgentSessionID    string
	TurnID            string
	ClientSubmitID    string
	CapabilityRefs    []CapabilityReference
	Content           []PromptContentBlock
	DisplayPrompt     string
	InitialTitle      string
	InitialTitleBase  string
	Metadata          map[string]any
	Guidance          bool
	TuttiModeSnapshot *TuttiModeTurnSnapshot
}

type CapabilityReference struct {
	Capability string
	Source     string
}

// TuttiModeTurnSnapshot is the immutable activation revision observed by one
// turn. It is an execution input, not a reconstruction from capability refs.
type TuttiModeTurnSnapshot struct {
	ActivationID           string
	RevisionID             string
	Revision               int64
	State                  string
	Source                 string
	OrchestrationIntensity int
}

type RuntimeExecResult struct {
	AgentSessionID     string
	Status             string
	TurnID             string
	Accepted           bool
	SessionStatus      string
	TurnLifecycle      TurnLifecycle
	SubmitAvailability SubmitAvailability
}

type RuntimeSubmitProvenanceInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	ClientSubmitID string
	Content        []PromptContentBlock
	DisplayPrompt  string
	Guidance       bool
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

type CancelTurnInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	Reason         string
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

type DeleteSessionsResult struct {
	RemovedSessionIDs []string
	RemovedSessions   int
	RemovedMessages   int
	RuntimeClosedIDs  []string
	CleanupFailedIDs  []string
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
