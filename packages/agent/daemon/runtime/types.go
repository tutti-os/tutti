package agentruntime

import (
	"strings"
	"sync/atomic"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
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
	Title                   string
	InitialTitleEstablished bool
	Visible                 *bool
	RuntimeContext          map[string]any
	ProviderTargetRef       map[string]any
	PermissionModeID        string
	Settings                *SessionSettings
	Provisional             bool
}

type ResumeInput struct {
	RoomID            string
	AgentSessionID    string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	CWD               string
	Env               []string
	Title             string
	Status            string
	Visible           *bool
	RuntimeContext    map[string]any
	ProviderTargetRef map[string]any
	PermissionModeID  string
	Settings          *SessionSettings
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
	// RecreateIfMissing creates a fresh provider session in place when the
	// existing provider session can no longer be restored locally (e.g. an
	// imported conversation), instead of returning a restore error.
	RecreateIfMissing bool
}

type CloseInput struct {
	RoomID         string
	AgentSessionID string
}

// TurnMetadata carries turn lineage for Retry/Edit. When non-nil, the runtime
// injects ParentTurnID and Relation into the submitted turn event so the Store
// persists the relationship alongside the new turn.
type TurnMetadata struct {
	ParentTurnID string
	Relation     string
}

type ExecInput struct {
	RoomID           string
	AgentSessionID   string
	Content          []PromptContentBlock
	DisplayPrompt    string
	InitialTitle     string
	InitialTitleBase string
	Metadata         map[string]any
	Guidance         bool
	TurnMetadata     *TurnMetadata
}

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
}

type Session struct {
	RoomID             string              `json:"roomId"`
	AgentSessionID     string              `json:"agentSessionId"`
	AgentTargetID      string              `json:"agentTargetId,omitempty"`
	Provider           string              `json:"provider"`
	ProviderSessionID  string              `json:"providerSessionId"`
	CWD                string              `json:"cwd,omitempty"`
	Env                []string            `json:"-"`
	Status             string              `json:"status"`
	TurnLifecycle      *TurnLifecycle      `json:"turnLifecycle,omitempty"`
	SubmitAvailability *SubmitAvailability `json:"submitAvailability,omitempty"`
	Title              string              `json:"title,omitempty"`
	LastError          string              `json:"lastError,omitempty"`
	Visible            bool                `json:"visible"`
	RuntimeContext     map[string]any      `json:"runtimeContext,omitempty"`
	ProviderTargetRef  map[string]any      `json:"-"`
	PermissionModeID   string              `json:"permissionModeId,omitempty"`
	Settings           *SessionSettings    `json:"settings,omitempty"`
	CreatedAtUnixMS    int64               `json:"createdAtUnixMs"`
	UpdatedAtUnixMS    int64               `json:"updatedAtUnixMs"`
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
	RoomID             string                    `json:"roomId"`
	AgentSessionID     string                    `json:"agentSessionId"`
	AgentTargetID      string                    `json:"agentTargetId,omitempty"`
	Provider           string                    `json:"provider"`
	ProviderSessionID  string                    `json:"providerSessionId,omitempty"`
	Status             string                    `json:"status"`
	TurnLifecycle      *TurnLifecycle            `json:"turnLifecycle,omitempty"`
	SubmitAvailability *SubmitAvailability       `json:"submitAvailability,omitempty"`
	PermissionModeID   string                    `json:"permissionModeId,omitempty"`
	Settings           *SessionSettings          `json:"settings,omitempty"`
	AuthState          string                    `json:"authState,omitempty"`
	RuntimeContext     map[string]any            `json:"runtimeContext,omitempty"`
	PendingInteractive *SessionInteractivePrompt `json:"pendingInteractive,omitempty"`
	UpdatedAtUnixMS    int64                     `json:"updatedAtUnixMs"`
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
}

type CloseResult struct {
	AgentSessionID string `json:"agentSessionId"`
	Disconnected   bool   `json:"disconnected"`
}

type ExecResult struct {
	AgentSessionID     string             `json:"agentSessionId"`
	Status             string             `json:"status"`
	TurnID             string             `json:"turnId,omitempty"`
	Accepted           bool               `json:"accepted"`
	SessionStatus      string             `json:"sessionStatus"`
	TurnLifecycle      TurnLifecycle      `json:"turnLifecycle"`
	SubmitAvailability SubmitAvailability `json:"submitAvailability"`
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
	Events         []Event                `json:"events"`
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
