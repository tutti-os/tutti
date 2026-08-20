package agenthost

import (
	"encoding/json"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// SessionRef identifies one canonical session without carrying host transport
// or authorization state.
type SessionRef struct {
	WorkspaceID    string
	AgentSessionID string
}

// DisconnectWorkspaceRuntimeResult reports provider runtime connections
// released without deleting their canonical or resumable session identity.
type DisconnectWorkspaceRuntimeResult struct {
	Scanned      int
	Disconnected int
	Failed       int
}

// RuntimeDisconnectTarget identifies an exact provider-connection incarnation
// for deferred attachment cleanup.
type RuntimeDisconnectTarget struct {
	WorkspaceID          string
	AgentSessionID       string
	ConnectionGeneration uint64
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

// SessionInteractionTreeQuery selects one root Turn. Empty means the latest
// non-retracted root Turn resolved atomically with the tree snapshot.
type SessionInteractionTreeQuery struct {
	RootTurnID string
}

// SessionInteractionTreeSnapshot contains the root Turn's interactions and
// every descendant Session's latest-Turn interactions.
type SessionInteractionTreeSnapshot struct {
	RootTurnID          string
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
	CodexSaverMode   bool
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
	CodexSaverMode   *bool
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
	Scope                   RuntimeSessionScope
	SourceAgentSessionID    string
	SideRequestID           string
	UserID                  string
	AgentTargetID           string
	Provider                string
	ProviderSessionID       string
	Resumable               bool
	Cwd                     string
	Env                     []string
	MCPServers              []MCPServerBinding
	ProviderTargetRef       map[string]any
	Settings                *ComposerSettings
	Capabilities            *canonical.CapabilitySnapshot
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
	// Asynchronous returns after the frozen durable operation is accepted.
	Asynchronous bool
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

type SessionTurnForkabilityInput struct {
	WorkspaceID             string
	SourceAgentSessionID    string
	CanonicalTurnID         string
	ProviderTurnID          string
	ProviderTurnBindingJSON json.RawMessage
}

type SessionForkCapabilities struct {
	FullSession bool
	ThroughTurn bool
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
	FullSession      bool
	ThroughTurn      bool
}

type RuntimeSessionForkInput struct {
	Source                        ProviderRuntimeSession
	SourceProviderTurnID          string
	SourceProviderTurnBindingJSON json.RawMessage
	TargetTitle                   string
	RequestID                     string
	Driver                        SessionForkDriverDescriptor
}

type SessionForkDeliveryDisposition string

const (
	SessionForkDeliveryNotStarted SessionForkDeliveryDisposition = "not_started"
	SessionForkDeliveryRejected   SessionForkDeliveryDisposition = "rejected"
	SessionForkDeliveryUnknown    SessionForkDeliveryDisposition = "unknown"
	SessionForkDeliveryAccepted   SessionForkDeliveryDisposition = "accepted"
)

type RuntimeSessionForkResult struct {
	ProviderSessionID          string
	TargetProviderTurnBindings []SessionForkProviderTurnBinding
	StateBindingMode           SessionForkStateBindingMode
	StateBindingReceipt        string
	DeliveryDisposition        SessionForkDeliveryDisposition
}

type SessionForkProviderTurnBinding struct {
	ProviderTurnID          string
	ProviderTurnBindingJSON json.RawMessage
}

type RuntimeProviderTurnForkabilityInput struct {
	Source                  ProviderRuntimeSession
	CanonicalTurnID         string
	ProviderTurnID          string
	ProviderTurnBindingJSON json.RawMessage
}

type RuntimeProviderTurnBindingRecoveryInput struct {
	Source               ProviderRuntimeSession
	CanonicalTurnID      string
	RecoveryToken        string
	LegacyTextHMACKey    string
	LegacyTextHMACDigest string
}

type RuntimeProviderTurnBindingRecoveryResult struct {
	ProviderSessionID       string
	ProviderTurnID          string
	ProviderTurnBindingJSON json.RawMessage
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
	MCPServers              []MCPServerBinding
	Title                   string
	InitialTitleEstablished bool
	PermissionModeID        string
	Model                   string
	PlanMode                bool
	BrowserUse              *bool
	ComputerUse             *bool
	CodexSaverMode          bool
	ProviderTargetRef       map[string]any
	RuntimeContext          map[string]any
	ReasoningEffort         string
	Speed                   string
	ConversationDetailMode  string
	Visible                 *bool
	Provisional             bool
	// CanonicalInitPending starts the provider runtime while keeping
	// its activity reports and stream events behind the Host-owned canonical
	// initialization barrier. Host releases that barrier only after the exact
	// canonical Session (including immutable rail placement) is durable.
	CanonicalInitPending bool
}

// RuntimeSessionInitializationPublishInput identifies the started Runtime
// Session whose canonical initialization barrier may be released. Publication
// is idempotent; it never creates or changes canonical rail placement itself.
type RuntimeSessionInitializationPublishInput struct {
	WorkspaceID    string
	AgentSessionID string
}

// RuntimeStartResult distinguishes a provider Runtime created by this exact
// call from an idempotently reused Runtime. CreateSession may compensate only
// resources it owns; a conflicting retry must never close an earlier live
// Session.
type RuntimeStartResult struct {
	Session ProviderRuntimeSession
	Created bool
}

type RuntimeResumeInput struct {
	WorkspaceID       string
	AgentSessionID    string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	Resumable         bool
	Cwd               string
	Env               []string
	MCPServers        []MCPServerBinding
	Title             string
	Status            string
	Settings          ComposerSettings
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
	Visible           *bool
	RuntimeContext    map[string]any
	// ProviderLaunchRuntimeContext is request-scoped context exposed only to
	// provider launch preparation. Runtime implementations must not retain or
	// publish it as canonical Session runtime context.
	ProviderLaunchRuntimeContext map[string]any
	ProviderTargetRef            map[string]any
	Metadata                     storesqlite.SessionMetadata
	InternalRuntimeContext       map[string]any
	// GoalGenerationFences are loaded from durable Host state and retained by
	// the Runtime before the resumed Session is exposed for Goal/Turn work.
	GoalGenerationFences []RuntimeGoalGenerationFenceInput
	// RecreateIfMissing lets the runtime start a fresh provider session in place
	// when the existing one can't be restored locally (imported conversations),
	// instead of surfacing a non-recoverable restore error.
	RecreateIfMissing bool
}

// ReprepareRuntimeSessionInput requests a fresh provider connection for one
// idle canonical Session. RuntimeContextOverlay is trusted, request-scoped
// preparation input. Host does not persist it or install it as provider
// runtime context; the preparation adapter may use it to mint an exact
// Invocation-scoped MCP binding.
type ReprepareRuntimeSessionInput struct {
	WorkspaceID           string
	AgentSessionID        string
	RuntimeContextOverlay map[string]any
}

// ReprepareRuntimeSessionAndSendInputInput atomically replaces an idle
// provider connection and admits the exact Turn that owns the replacement
// bindings. This prevents another mutation lane from using request-scoped
// launch authority between reprepare and Turn admission.
type ReprepareRuntimeSessionAndSendInputInput struct {
	Reprepare ReprepareRuntimeSessionInput
	Send      SendInput
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
	// ConnectorRoutingUpdate carries the current connector alias index when it
	// diverged from the index materialized into the session's instructions.
	// The runtime renders it into provider-only content; canonical prompt
	// content never includes it. Nil means the instructions are still current.
	ConnectorRoutingUpdate *string
}

type CapabilityReference = storesqlite.CapabilityReference

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
	RuntimeDispatchDispositionApplied                    RuntimeDispatchDisposition = "applied"
	RuntimeDispatchDispositionAppliedWithoutProviderTurn RuntimeDispatchDisposition = "applied_without_provider_turn"
	RuntimeDispatchDispositionRejected                   RuntimeDispatchDisposition = "rejected"
	RuntimeDispatchDispositionNotDispatched              RuntimeDispatchDisposition = "not_dispatched"
	RuntimeDispatchDispositionOutcomeUnknown             RuntimeDispatchDisposition = "outcome_unknown"
)

type RuntimeAcceptanceSource string

const (
	RuntimeAcceptanceSourceTurnStartResponse RuntimeAcceptanceSource = "turn_start_response"
	RuntimeAcceptanceSourceHistoryRead       RuntimeAcceptanceSource = "history_read"
)

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
	// ClientUserMessageID is opaque provider correlation evidence. It must not
	// reuse the canonical RootTurnID as provider-owned client identity.
	ClientUserMessageID string
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
	// PreserveCanonicalState removes the provider runtime without publishing a
	// canonical Session completion over an already-durable terminal state.
	PreserveCanonicalState bool
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
	ConnectorKey string `json:"connectorKey,omitempty"`
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

// RailPlacement is the caller-selected conversation-rail identity for a newly
// created session. Host canonicalizes project paths and derives project
// SectionKey values from them; conversation placement uses the canonical
// conversations key. ProjectPath is the caller's logical project path, not a
// prepared runtime or owner-host path.
type RailPlacement struct {
	Version     int               `json:"version"`
	Kind        RailPlacementKind `json:"kind"`
	ProjectPath string            `json:"projectPath,omitempty"`
	SectionKey  string            `json:"sectionKey"`
}

// ResolveRuntimeSessionRailPlacementInput identifies the final prepared
// runtime context whose canonical rail placement must be known before a
// provider process starts.
type ResolveRuntimeSessionRailPlacementInput struct {
	WorkspaceID                string
	AgentSessionID             string
	Cwd                        string
	RuntimeContext             map[string]any
	RailPlacement              *RailPlacement
	RailPlacementAuthoritative bool
}

// CreateSessionInput is the provider-neutral create contract. Adapter-only
// import paths, workspace resolution, identity, and transport state are not
// part of this type.
type CreateSessionInput struct {
	// ActivationID correlates the caller's activation request across Engine,
	// desktop transport, Host lifecycle diagnostics, and terminal failure.
	ActivationID   string
	AgentSessionID string
	AgentTargetID  string
	Provider       string
	InitialContent []PromptContentBlock
	// InitialGoalControl applies a Goal mutation after creating the Session
	// without opening an initial Turn. It is mutually exclusive with
	// InitialContent; ClientSubmitID is the durable mutation identity.
	InitialGoalControl   *TypedGoalControl
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
	CodexSaverMode         *bool
	ProviderTargetRef      map[string]any
	ReasoningEffort        *string
	RuntimeContext         map[string]any
	Speed                  *string
	ConversationDetailMode string
	Visible                *bool
	RailPlacement          *RailPlacement
	// RailPlacementAuthoritative declares that RailPlacement was selected by
	// an external canonical authority and may name a project absent from this
	// Host's local project registry. It applies only to first initialization
	// and never permits replacing an existing canonical placement.
	RailPlacementAuthoritative bool
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
	// ConnectorRoutingUpdate is set by the service when the connector alias
	// index changed after this session's instructions were prepared. See
	// RuntimeExecInput.ConnectorRoutingUpdate.
	ConnectorRoutingUpdate *string
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

// EditRetryReasonCode is the stable, coarse provider-neutral classification
// shared by Host projections and durable edit-retry operations. Provider codes
// and diagnostics must not be exposed or persisted through this type.
type EditRetryReasonCode = canonical.EditRetryReasonCode

const (
	EditRetryReasonCodeProviderUnsupported        = canonical.EditRetryReasonProviderUnsupported
	EditRetryReasonCodeTurnNotFound               = canonical.EditRetryReasonTurnNotFound
	EditRetryReasonCodeTurnNotLatest              = canonical.EditRetryReasonTurnNotLatest
	EditRetryReasonCodeTurnNotSettled             = canonical.EditRetryReasonTurnNotSettled
	EditRetryReasonCodeHistoryRevisionConflict    = canonical.EditRetryReasonHistoryRevisionConflict
	EditRetryReasonCodeOperationConflict          = canonical.EditRetryReasonOperationConflict
	EditRetryReasonCodeRecoveryRequired           = canonical.EditRetryReasonRecoveryRequired
	EditRetryReasonCodeProviderOutcomeUnknown     = canonical.EditRetryReasonProviderOutcomeUnknown
	EditRetryReasonCodeReplacementNotProvenAbsent = canonical.EditRetryReasonReplacementNotProvenAbsent
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
	Session           ProviderRuntimeSession
	Canonical         storesqlite.Session
	TurnID            string
	Kind              string
	GoalControl       *GoalControlResult
	SessionStatus     CreateSessionStatus
	InitialGoalStatus CreateSessionInitialGoalStatus
}

type CreateSessionStatus string

const (
	CreateSessionStatusUnknown    CreateSessionStatus = "unknown"
	CreateSessionStatusCreated    CreateSessionStatus = "created"
	CreateSessionStatusNotCreated CreateSessionStatus = "not_created"
)

type CreateSessionInitialGoalStatus string

const (
	CreateSessionInitialGoalStatusNotRequested CreateSessionInitialGoalStatus = "not_requested"
	CreateSessionInitialGoalStatusSucceeded    CreateSessionInitialGoalStatus = "succeeded"
	CreateSessionInitialGoalStatusFailed       CreateSessionInitialGoalStatus = "failed"
	CreateSessionInitialGoalStatusUnknown      CreateSessionInitialGoalStatus = "unknown"
)

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
	WorkspaceID                string
	SessionIDs                 []string
	RequiredRootRailSectionKey string
	ExcludePinnedRoots         bool
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
	// ExecutionPending is explicit provider evidence that this Goal mutation
	// will begin autonomous execution. Host persists it until the first exact
	// Goal Turn is canonical or the Goal reaches a terminal state.
	ExecutionPending bool
}

// RuntimeGoalControlAppliedInput is an internal runtime-to-Host lifecycle
// observation. Operation identity and revision are mandatory stale-event
// fences; provider output alone is never allowed to settle another command.
type RuntimeGoalControlAppliedInput struct {
	WorkspaceID      string
	AgentSessionID   string
	OperationID      string
	GoalRevision     int64
	RepairEpoch      int64
	Action           string
	ProviderTurnID   string
	Observed         map[string]any
	OccurredAtUnixMS int64
	ExecutionPending bool
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
	Canonical storesqlite.Session
	Goal      map[string]any
	// IntentAccepted means the durable Goal operation exists and Host owns
	// recovery. It does not claim immediate provider delivery or convergence;
	// callers must inspect GoalState for pending, applying, or terminal state.
	IntentAccepted bool
	OperationID    string
	GoalState      *storesqlite.SessionGoalState
}

// ProviderGoalAdoptionInput identifies one Goal generation that the provider
// created while executing an accepted Turn. Fingerprint is derived from the
// provider's immutable generation fields and makes notification replay
// idempotent.
type ProviderGoalAdoptionInput struct {
	WorkspaceID       string
	AgentSessionID    string
	ProviderSessionID string
	Fingerprint       string
	// ExpectedRevision is the canonical Goal revision observed when the
	// provider generation entered the adoption lane. Host rejects the
	// adoption if a newer set/clear/pause/resume serialized first.
	ExpectedRevision int64
	Goal             map[string]any
}

type ProviderGoalAdoptionResult struct {
	Canonical   storesqlite.Session
	Goal        map[string]any
	OperationID string
	Revision    int64
	RepairEpoch int64
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
