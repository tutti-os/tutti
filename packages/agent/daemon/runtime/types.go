package agentruntime

import (
	"encoding/json"
	"strings"
	"sync/atomic"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

const (
	ProviderClaudeCode = providerregistry.ClaudeCodeProviderID
	ProviderCodex      = providerregistry.CodexProviderID
	ProviderTuttiAgent = providerregistry.TuttiAgentProviderID
	ProviderCursor     = providerregistry.CursorProviderID
	ProviderNexight    = providerregistry.NexightProviderID
	ProviderOpenClaw   = providerregistry.OpenClawProviderID
	ProviderOpenCode   = providerregistry.OpenCodeProviderID

	SessionStatusReady     = "ready"
	SessionStatusWorking   = "working"
	SessionStatusWaiting   = "waiting"
	SessionStatusCanceled  = "canceled"
	SessionStatusFailed    = "failed"
	SessionStatusCompleted = "completed"

	RoleUser              = "user"
	RoleAssistant         = "assistant"
	RoleAssistantThinking = "assistant_thinking"

	EventSessionStarted   = "session.started"
	EventSessionUpdated   = "session.updated"
	EventSessionCompleted = "session.completed"
	EventSessionFailed    = "session.failed"
	EventSessionCanceled  = "session.canceled"
	EventSessionAudit     = "session.audit"
	EventTurnStarted      = "turn.started"
	EventTurnUpdated      = "turn.updated"
	EventTurnCompleted    = "turn.completed"
	EventTurnFailed       = "turn.failed"
	EventTurnCanceled     = "turn.canceled"
	EventMessage          = "message"
	EventCallStarted      = "call.started"
	EventCallCompleted    = "call.completed"
	EventCallFailed       = "call.failed"

	ExecStatusStarted = "started"

	messageContentModeSnapshot  = "snapshot"
	messageStreamStateStreaming = "streaming"
	messageStreamStateCompleted = "completed"
	messageStreamStateFailed    = "failed"

	StreamEventMessageUpdate     = "message_update"
	StreamEventMessageDelta      = "message_delta"
	StreamEventStatePatch        = "state_patch"
	StreamEventAvailableCommands = "available_commands_update"
	StreamEventConfigOptions     = "config_options_update"
	StreamEventSessionAudit      = "session_audit"
)

type StartInput struct {
	RoomID                  string
	AgentSessionID          string
	AgentTargetID           string
	Provider                string
	CWD                     string
	Env                     []string
	MCPServers              []MCPServerBinding
	Title                   string
	InitialTitleEstablished bool
	Visible                 *bool
	RuntimeContext          map[string]any
	ProviderTargetRef       map[string]any
	PermissionModeID        string
	Settings                *SessionSettings
	Provisional             bool
	CanonicalInitPending    bool
}

type ResumeInput struct {
	RoomID            string
	AgentSessionID    string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	Resumable         bool
	CWD               string
	Env               []string
	MCPServers        []MCPServerBinding
	Title             string
	Status            string
	Visible           *bool
	RuntimeContext    map[string]any
	// ProviderLaunchRuntimeContext is an ephemeral overlay visible only to
	// ProviderLaunchPreparer while establishing this live connection.
	ProviderLaunchRuntimeContext map[string]any
	ProviderTargetRef            map[string]any
	PermissionModeID             string
	Settings                     *SessionSettings
	CreatedAtUnixMS              int64
	UpdatedAtUnixMS              int64
	// GoalGenerationFences must be retained before this Session becomes
	// available for Goal or Turn submission. Adapter installation follows
	// Resume connection establishment and precedes Controller publication.
	GoalGenerationFences []GoalGenerationFenceInput
	// RecreateIfMissing creates a fresh provider session in place when the
	// existing provider session can no longer be restored locally (e.g. an
	// imported conversation), instead of returning a restore error.
	RecreateIfMissing bool
}

type CloseInput struct {
	RoomID         string
	AgentSessionID string
	// PreserveCanonicalState removes the live runtime without emitting a
	// session_completed event over an already-durable terminal state.
	PreserveCanonicalState bool
}

// SessionForkCapabilities reports provider-native fork boundaries supported by
// the exact runtime currently attached to a session.
type SessionForkCapabilities struct {
	DriverKind       string `json:"driverKind,omitempty"`
	DriverVersion    string `json:"driverVersion,omitempty"`
	StateBindingMode string `json:"stateBindingMode,omitempty"`
	FullSession      bool   `json:"fullSession"`
	ThroughTurn      bool   `json:"throughTurn"`
}

// SessionForkInput identifies a provider source and optional inclusive
// provider-turn boundary. ProviderTurnID is deliberately distinct from the
// canonical WorkspaceAgentTurn id.
type SessionForkInput struct {
	Source                  Session         `json:"-"`
	ProviderTurnID          string          `json:"providerTurnId,omitempty"`
	ProviderTurnBindingJSON json.RawMessage `json:"providerTurnBindingJson,omitempty"`
	TargetTitle             string          `json:"targetTitle,omitempty"`
}

type SessionForkDeliveryDisposition string

const (
	SessionForkDeliveryNotStarted SessionForkDeliveryDisposition = "not_started"
	SessionForkDeliveryRejected   SessionForkDeliveryDisposition = "rejected"
	SessionForkDeliveryUnknown    SessionForkDeliveryDisposition = "unknown"
	SessionForkDeliveryAccepted   SessionForkDeliveryDisposition = "accepted"
)

// SessionForkResult contains only provider-native durable identity. Canonical
// session creation and history copying are owned by the host.
type SessionForkResult struct {
	ProviderSessionID           string                           `json:"providerSessionId"`
	ForkedFromProviderSessionID string                           `json:"forkedFromProviderSessionId"`
	ThroughProviderTurnID       string                           `json:"throughProviderTurnId,omitempty"`
	TargetProviderTurnBindings  []SessionForkProviderTurnBinding `json:"targetProviderTurnBindings,omitempty"`
	StateBindingMode            string                           `json:"stateBindingMode,omitempty"`
	StateBindingReceipt         string                           `json:"stateBindingReceipt,omitempty"`
	DeliveryDisposition         SessionForkDeliveryDisposition   `json:"deliveryDisposition"`
}

type SessionForkProviderTurnBinding struct {
	ProviderTurnID          string          `json:"providerTurnId"`
	ProviderTurnBindingJSON json.RawMessage `json:"providerTurnBindingJson"`
}

const (
	ProviderTurnBindingWriteStarted    = "started"
	ProviderTurnBindingWriteCheckpoint = "checkpoint"
	ProviderTurnBindingWriteForked     = "forked"
	ProviderTurnBindingWriteRecovered  = "recovered"
)

// ProviderTurnBindingWriteInput is deliberately provider-neutral. Payload is
// supplied by the provider adapter and interpreted only by that adapter.
type ProviderTurnBindingWriteInput struct {
	Kind           string
	ProviderTurnID string
	Payload        map[string]any
}

type ProviderTurnForkabilityInput struct {
	Source                  Session
	CanonicalTurnID         string
	ProviderTurnID          string
	ProviderTurnBindingJSON json.RawMessage
}

type ProviderTurnBindingRecoveryInput struct {
	Source               Session
	CanonicalTurnID      string
	RecoveryToken        string
	LegacyTextHMACKey    string
	LegacyTextHMACDigest string
}

type ProviderTurnBindingRecoveryResult struct {
	ProviderSessionID       string
	ProviderTurnID          string
	ProviderTurnBindingJSON json.RawMessage
}

type ExecInput struct {
	RoomID         string
	AgentSessionID string
	TurnID         string
	// ClientSubmitID is a typed host identity. The controller may project it
	// into adapter execution metadata, but callers must not encode it there.
	ClientSubmitID                  string
	CanonicalSubmitOccurredAtUnixMS int64
	CapabilityRefs                  []CapabilityReference
	TuttiModeSnapshot               *TuttiModeTurnSnapshot
	Content                         []PromptContentBlock
	DisplayPrompt                   string
	InitialTitle                    string
	InitialTitleBase                string
	Metadata                        map[string]any
	Guidance                        bool
	// ConnectorRoutingUpdate carries the current connector alias index when it
	// diverged from the index materialized into the session's instructions at
	// preparation time. The controller renders it into provider-facing content
	// only; canonical prompt content never includes it. Nil means no update.
	ConnectorRoutingUpdate *string
	// HistoryReplacement requires a fresh provider turn. It may not steer an
	// active turn or reinterpret the edited text as a provider slash command.
	// The provider's complete EffectiveHistoryAdapter seam always returns one
	// typed dispatch result before this call completes.
	HistoryReplacement bool
	// RequireProviderAcceptance keeps the canonical Turn of a fork-capable
	// provider in its submitted boundary until the provider has returned an
	// exact Turn identity and that binding has crossed the durable activity
	// reporter. Compatibility-only adapters have no Fork entry or Turn binding
	// contract and continue through the ordinary execution path.
	RequireProviderAcceptance bool
}

// SubmitProvenanceInput describes the canonical user submit that an adapter
// has already accepted. It is reported separately from Exec so waiting for
// durable provenance never happens while Exec holds the session lifecycle
// lock.
type SubmitProvenanceInput struct {
	RoomID                          string
	AgentSessionID                  string
	TurnID                          string
	ClientSubmitID                  string
	CanonicalSubmitOccurredAtUnixMS int64
	Content                         []PromptContentBlock
	DisplayPrompt                   string
	Guidance                        bool
}

type CapabilityReference = activityshared.CapabilityReference

const (
	TuttiModeStateActive   = "active"
	TuttiModeStateInactive = "inactive"
)

// TuttiModeTurnSnapshot is the immutable runtime projection of the durable
// TuttiModeActivation revision selected for one canonical turn. It carries
// facts only; provider-facing instruction text is rendered inside this
// package so callers cannot smuggle arbitrary prompt content through it.
type TuttiModeTurnSnapshot struct {
	ActivationID      string
	RevisionID        string
	Revision          int64
	State             string
	Source            string
	PreferenceVersion int
	// Effect and Speed are the user-selected outcome-quality and
	// completion-speed preferences captured by the exact activation revision.
	Effect int
	Speed  int
	// OrchestrationIntensity is the legacy single-axis alias of Effect.
	//
	// Deprecated: use Effect and Speed with PreferenceVersion set to
	// TuttiModePreferenceVersionEffectSpeed.
	OrchestrationIntensity int
}

const TuttiModePreferenceVersionEffectSpeed = 1

type CancelInput struct {
	RoomID             string
	RootAgentSessionID string
	Targets            []CancelTarget
	Reason             string
}

// CancelTarget identifies one canonical root or child turn. The root session
// selects the live provider runtime; targets select the durable entities that
// the provider operation must stop.
type CancelTarget struct {
	AgentSessionID string
	TurnID         string
}

type PermissionOptionInput struct {
	RoomID         string
	AgentSessionID string
	TurnID         string
	RequestID      string
	OptionID       string
}

type SubmitInteractiveInput struct {
	RoomID             string
	RootAgentSessionID string
	AgentSessionID     string
	TurnID             string
	RequestID          string
	Action             string
	OptionID           string
	Payload            map[string]any
}

type InteractiveDisposition string

const (
	InteractiveDispositionPending     InteractiveDisposition = "pending"
	InteractiveDispositionResolving   InteractiveDisposition = "resolving"
	InteractiveDispositionAnswered    InteractiveDisposition = "answered"
	InteractiveDispositionSuperseded  InteractiveDisposition = "superseded"
	InteractiveDispositionInterrupted InteractiveDisposition = "interrupted"
	InteractiveDispositionUnknown     InteractiveDisposition = "unknown"
)

type interactiveRequestKey struct {
	agentSessionID string
	turnID         string
	requestID      string
}

func newInteractiveRequestKey(agentSessionID string, turnID string, requestID string) interactiveRequestKey {
	return interactiveRequestKey{
		agentSessionID: strings.TrimSpace(agentSessionID),
		turnID:         strings.TrimSpace(turnID),
		requestID:      strings.TrimSpace(requestID),
	}
}

type UpdateSettingsInput struct {
	RoomID         string
	AgentSessionID string
	Settings       SessionSettingsPatch
}

type SessionSettings struct {
	CodexSaverMode         bool   `json:"codexSaverMode,omitempty"`
	Model                  string `json:"model,omitempty"`
	ReasoningEffort        string `json:"reasoningEffort,omitempty"`
	Speed                  string `json:"speed,omitempty"`
	PlanMode               bool   `json:"planMode,omitempty"`
	BrowserUse             *bool  `json:"browserUse,omitempty"`
	ComputerUse            *bool  `json:"computerUse,omitempty"`
	PermissionModeID       string `json:"permissionModeId,omitempty"`
	ConversationDetailMode string `json:"conversationDetailMode,omitempty"`
}

type SessionSettingsPatch struct {
	Model            *string `json:"model,omitempty"`
	ReasoningEffort  *string `json:"reasoningEffort,omitempty"`
	Speed            *string `json:"speed,omitempty"`
	PlanMode         *bool   `json:"planMode,omitempty"`
	BrowserUse       *bool   `json:"browserUse,omitempty"`
	ComputerUse      *bool   `json:"computerUse,omitempty"`
	PermissionModeID *string `json:"permissionModeId,omitempty"`
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

type Session struct {
	RoomID             string `json:"roomId"`
	AgentSessionID     string `json:"agentSessionId"`
	RootAgentSessionID string `json:"rootAgentSessionId,omitempty"`
	// Scope separates durable workspace sessions from runtime-only side
	// conversations. The empty value is canonical for backwards compatibility.
	Scope                RuntimeSessionScope `json:"scope,omitempty"`
	SourceAgentSessionID string              `json:"sourceAgentSessionId,omitempty"`
	SideRequestID        string              `json:"sideRequestId,omitempty"`
	AgentTargetID        string              `json:"agentTargetId,omitempty"`
	Provider             string              `json:"provider"`
	ProviderSessionID    string              `json:"providerSessionId"`
	Resumable            bool                `json:"resumable"`
	CWD                  string              `json:"cwd,omitempty"`
	Env                  []string            `json:"-"`
	MCPServers           []MCPServerBinding  `json:"-"`
	Status               string              `json:"status"`
	TurnLifecycle        *TurnLifecycle      `json:"turnLifecycle,omitempty"`
	SubmitAvailability   *SubmitAvailability `json:"submitAvailability,omitempty"`
	Title                string              `json:"title,omitempty"`
	LastError            string              `json:"lastError,omitempty"`
	Visible              bool                `json:"visible"`
	RuntimeContext       map[string]any      `json:"runtimeContext,omitempty"`
	ProviderTargetRef    map[string]any      `json:"-"`
	PermissionModeID     string              `json:"permissionModeId,omitempty"`
	Settings             *SessionSettings    `json:"settings,omitempty"`
	CreatedAtUnixMS      int64               `json:"createdAtUnixMs"`
	UpdatedAtUnixMS      int64               `json:"updatedAtUnixMs"`
	// LifecycleAuthority is set once an adapter-origin TurnLifecycle snapshot
	// was applied (ADR 0008). Authority sessions copy lifecycle from
	// snapshots and derive Status purely; legacy sessions keep the historic
	// event-folding path until their provider publishes snapshots (Phase B).
	LifecycleAuthority bool `json:"-"`
	// LifecycleSeq is the sequence of the last applied lifecycle snapshot;
	// lower-seq snapshots arriving over a slower channel are dropped.
	LifecycleSeq uint64 `json:"-"`
	// InitialTitleEstablished prevents a first-submit title candidate from
	// overwriting a title established concurrently in this runtime.
	InitialTitleEstablished bool `json:"-"`
	// UserTitleSet records that the title was explicitly set by the user through
	// SetTitle. It is runtime-only (never persisted): once set, provider/event
	// title candidates are no longer applied, so a late provider title cannot
	// revert a user rename. On resume the value fails closed to the established
	// title so a restarted runtime never lets a provider title clobber a
	// persisted user title.
	UserTitleSet bool `json:"-"`
}

type MCPServerBinding struct {
	Name    string
	Type    string
	URL     string
	Headers map[string]string
}

func cloneMCPServerBindings(input []MCPServerBinding) []MCPServerBinding {
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

type RuntimeSessionScope string

const (
	RuntimeSessionScopeCanonical RuntimeSessionScope = "canonical"
	RuntimeSessionScopeSide      RuntimeSessionScope = "side"
)

func (s Session) IsSideConversation() bool {
	return s.Scope == RuntimeSessionScopeSide
}

type SideConversationCapabilities struct {
	Supported             bool `json:"supported"`
	ActiveSourceTurn      bool `json:"activeSourceTurn"`
	Ephemeral             bool `json:"ephemeral"`
	HideInheritedTurns    bool `json:"hideInheritedTurns"`
	ModelBoundaryInjected bool `json:"modelBoundaryInjected"`
}

type SideConversationOpenInput struct {
	RoomID               string  `json:"roomId"`
	SourceAgentSessionID string  `json:"sourceAgentSessionId"`
	SideAgentSessionID   string  `json:"sideAgentSessionId"`
	RequestID            string  `json:"requestId"`
	Source               Session `json:"-"`
}

type SideConversationAdapterOpenInput struct {
	Source    Session `json:"-"`
	Side      Session `json:"-"`
	RequestID string  `json:"requestId"`
}

type SideConversationOpenResult struct {
	Session      Session                      `json:"session"`
	Capabilities SideConversationCapabilities `json:"capabilities"`
}

type SessionInteractivePrompt struct {
	Kind      string         `json:"kind"`
	RequestID string         `json:"requestId,omitempty"`
	ToolName  string         `json:"toolName,omitempty"`
	Status    string         `json:"status,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	Output    map[string]any `json:"output,omitempty"`
	Error     map[string]any `json:"error,omitempty"`
	Metadata  map[string]any `json:"metadata,omitempty"`
}

type SessionStateSnapshot struct {
	RoomID             string                        `json:"roomId"`
	AgentSessionID     string                        `json:"agentSessionId"`
	AgentTargetID      string                        `json:"agentTargetId,omitempty"`
	Provider           string                        `json:"provider"`
	ProviderSessionID  string                        `json:"providerSessionId,omitempty"`
	Resumable          bool                          `json:"resumable"`
	Status             string                        `json:"status"`
	TurnLifecycle      *TurnLifecycle                `json:"turnLifecycle,omitempty"`
	SubmitAvailability *SubmitAvailability           `json:"submitAvailability,omitempty"`
	PermissionModeID   string                        `json:"permissionModeId,omitempty"`
	Settings           *SessionSettings              `json:"settings,omitempty"`
	Capabilities       *canonical.CapabilitySnapshot `json:"capabilities,omitempty"`
	AuthState          string                        `json:"authState,omitempty"`
	RuntimeContext     map[string]any                `json:"runtimeContext,omitempty"`
	PendingInteractive *SessionInteractivePrompt     `json:"pendingInteractive,omitempty"`
	UpdatedAtUnixMS    int64                         `json:"updatedAtUnixMs"`
}

type AgentSessionCommand struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	InputHint   string `json:"inputHint,omitempty"`
}

type AgentSessionCommandSnapshot struct {
	AgentSessionID string                `json:"agentSessionId"`
	Commands       []AgentSessionCommand `json:"commands"`
}

type AgentSessionConfigOptionsUpdate struct {
	RoomID            string `json:"roomId,omitempty"`
	AgentSessionID    string `json:"agentSessionId"`
	Provider          string `json:"provider,omitempty"`
	ProviderSessionID string `json:"providerSessionId,omitempty"`
	ConfigOptionKey   string `json:"configOptionKey,omitempty"`
	OccurredAtUnixMS  int64  `json:"occurredAtUnixMs"`
}

type Event struct {
	ID                string         `json:"id"`
	RoomID            string         `json:"roomId"`
	AgentSessionID    string         `json:"agentSessionId"`
	Provider          string         `json:"provider"`
	ProviderSessionID string         `json:"providerSessionId,omitempty"`
	Type              string         `json:"type"`
	TurnID            string         `json:"turnId,omitempty"`
	Role              string         `json:"role,omitempty"`
	Content           string         `json:"content,omitempty"`
	Status            string         `json:"status,omitempty"`
	Payload           map[string]any `json:"payload,omitempty"`
	OccurredAtUnixMS  int64          `json:"occurredAtUnixMs"`
}

type StreamEvent struct {
	EventType string `json:"event_type"`
	Data      any    `json:"data"`
}

type StartResult struct {
	Session Session `json:"session"`
	Created bool    `json:"created"`
}

type CloseResult struct {
	AgentSessionID string `json:"agentSessionId"`
	Disconnected   bool   `json:"disconnected"`
}

type ExecResult struct {
	AgentSessionID     string                  `json:"agentSessionId"`
	Status             string                  `json:"status"`
	TurnID             string                  `json:"turnId,omitempty"`
	Accepted           bool                    `json:"accepted"`
	SessionStatus      string                  `json:"sessionStatus"`
	TurnLifecycle      TurnLifecycle           `json:"turnLifecycle"`
	SubmitAvailability SubmitAvailability      `json:"submitAvailability"`
	ProviderDispatch   *ProviderDispatchResult `json:"providerDispatch,omitempty"`
}

type DispatchDisposition string

const (
	DispatchDispositionApplied                    DispatchDisposition = "applied"
	DispatchDispositionAppliedWithoutProviderTurn DispatchDisposition = "applied_without_provider_turn"
	DispatchDispositionRejected                   DispatchDisposition = "rejected"
	DispatchDispositionNotDispatched              DispatchDisposition = "not_dispatched"
	DispatchDispositionOutcomeUnknown             DispatchDisposition = "outcome_unknown"
)

type AcceptanceSource string

const (
	AcceptanceSourceTurnStartResponse AcceptanceSource = "turn_start_response"
	AcceptanceSourceHistoryRead       AcceptanceSource = "history_read"
)

type ProviderAcceptanceReceipt struct {
	Source            AcceptanceSource `json:"source"`
	ProviderSessionID string           `json:"providerSessionId"`
	ProviderTurnID    string           `json:"providerTurnId"`
	// ProviderInputUnit is process-local Replay metadata from the stamped
	// acceptance event. It must travel with the durable acceptance report so
	// commit correlation can confirm against the same transaction that writes
	// RootProviderTurn (Claude Code otherwise re-emits a later no-op report).
	ProviderInputUnit *activityshared.ProviderInputUnitContext `json:"-"`
}

// ProviderAcceptanceDiagnostics describes the identity evidence observed at
// the provider acceptance boundary. It is telemetry metadata only and must not
// be used as durable coordination state.
type ProviderAcceptanceDiagnostics struct {
	Status                   string `json:"status"`
	ProviderSessionIDPresent bool   `json:"providerSessionIdPresent"`
	ProviderTurnIDPresent    bool   `json:"providerTurnIdPresent"`
	ProviderTurnIDSource     string `json:"providerTurnIdSource,omitempty"`
	FailureReason            string `json:"failureReason,omitempty"`
}

type ProviderDispatchResult struct {
	Disposition           DispatchDisposition            `json:"disposition"`
	Acceptance            *ProviderAcceptanceReceipt     `json:"acceptance,omitempty"`
	AcceptanceDiagnostics *ProviderAcceptanceDiagnostics `json:"acceptanceDiagnostics,omitempty"`
	// Failure is a process-local provider observation. It is carried only to
	// the synchronous Controller caller and is never serialized or persisted as
	// coordination state.
	Failure error `json:"-"`
}

type CompletedCommand struct {
	Kind   string `json:"kind"`
	Status string `json:"status"`
}

type SubmitAvailability struct {
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

type TurnLifecycle struct {
	ActiveTurnID     *string           `json:"activeTurnId"`
	Phase            string            `json:"phase"`
	Settling         bool              `json:"settling,omitempty"`
	Outcome          *string           `json:"outcome,omitempty"`
	CompletedCommand *CompletedCommand `json:"completedCommand,omitempty"`
}

type CancelResult struct {
	AgentSessionID   string         `json:"agentSessionId"`
	Canceled         bool           `json:"canceled"`
	TargetAbsent     bool           `json:"targetAbsent,omitempty"`
	ConfirmedTargets []CancelTarget `json:"confirmedTargets,omitempty"`
}

type SubmitInteractiveResult struct {
	AgentSessionID string                 `json:"agentSessionId"`
	RequestID      string                 `json:"requestId"`
	Accepted       bool                   `json:"accepted"`
	OptionID       string                 `json:"optionId,omitempty"`
	Disposition    InteractiveDisposition `json:"-"`
	// FollowUpPrompt is a provider-neutral intent for the Host to submit a
	// follow-up through its normal SendInput admission path. Runtime must not
	// dispatch this prompt directly because Host owns its idempotency and
	// recovery semantics.
	FollowUpPrompt string  `json:"-"`
	Events         []Event `json:"events"`
}

type UpdateSettingsResult struct {
	AgentSessionID string          `json:"agentSessionId"`
	Settings       SessionSettings `json:"settings"`
}

func unixMS(t time.Time) int64 {
	return t.UnixNano() / int64(time.Millisecond)
}

var lastEventUnixMS atomic.Int64

func nextEventUnixMS() int64 {
	current := unixMS(now())
	for {
		last := lastEventUnixMS.Load()
		if current <= last {
			current = last + 1
		}
		if lastEventUnixMS.CompareAndSwap(last, current) {
			return current
		}
	}
}

func observeEventUnixMS(value int64) {
	for value > 0 {
		last := lastEventUnixMS.Load()
		if value <= last || lastEventUnixMS.CompareAndSwap(last, value) {
			return
		}
	}
}
