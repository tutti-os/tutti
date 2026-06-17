package agentruntime

import (
	"sync/atomic"
	"time"
)

const (
	ProviderClaudeCode = "claude-code"
	ProviderCodex      = "codex"
	ProviderNexight    = "nexight"
	ProviderGemini     = "gemini"
	ProviderHermes     = "hermes"
	ProviderOpenClaw   = "openclaw"

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
)

type StartInput struct {
	RoomID               string
	AgentSessionID       string
	Provider             string
	CWD                  string
	Env                  []string
	Title                string
	Visible              *bool
	OpenclawGatewayReady bool
	PermissionModeID     string
	Settings             *SessionSettings
}

type ResumeInput struct {
	RoomID            string
	AgentSessionID    string
	Provider          string
	ProviderSessionID string
	CWD               string
	Env               []string
	Title             string
	Status            string
	Visible           *bool
	PermissionModeID  string
	Settings          *SessionSettings
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type CloseInput struct {
	RoomID         string
	AgentSessionID string
}

type ExecInput struct {
	RoomID         string
	AgentSessionID string
	Content        []PromptContentBlock
	DisplayPrompt  string
}

type CancelInput struct {
	RoomID         string
	AgentSessionID string
	Reason         string
}

type PermissionOptionInput struct {
	RoomID         string
	AgentSessionID string
	RequestID      string
	OptionID       string
}

type SubmitInteractiveInput struct {
	RoomID         string
	AgentSessionID string
	RequestID      string
	Action         string
	OptionID       string
	Payload        map[string]any
}

type UpdateSettingsInput struct {
	RoomID         string
	AgentSessionID string
	Settings       SessionSettingsPatch
}

type SessionSettings struct {
	Model            string `json:"model,omitempty"`
	ReasoningEffort  string `json:"reasoningEffort,omitempty"`
	Speed            string `json:"speed,omitempty"`
	PlanMode         bool   `json:"planMode,omitempty"`
	BrowserUse       *bool  `json:"browserUse,omitempty"`
	PermissionModeID string `json:"permissionModeId,omitempty"`
}

type SessionSettingsPatch struct {
	Model            *string `json:"model,omitempty"`
	ReasoningEffort  *string `json:"reasoningEffort,omitempty"`
	Speed            *string `json:"speed,omitempty"`
	PlanMode         *bool   `json:"planMode,omitempty"`
	BrowserUse       *bool   `json:"browserUse,omitempty"`
	PermissionModeID *string `json:"permissionModeId,omitempty"`
}

type PromptContentBlock struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	MimeType     string `json:"mimeType,omitempty"`
	Data         string `json:"data,omitempty"`
	AttachmentID string `json:"attachmentId,omitempty"`
	Name         string `json:"name,omitempty"`
}

type Session struct {
	RoomID               string           `json:"roomId"`
	AgentSessionID       string           `json:"agentSessionId"`
	Provider             string           `json:"provider"`
	ProviderSessionID    string           `json:"providerSessionId"`
	CWD                  string           `json:"cwd,omitempty"`
	Env                  []string         `json:"-"`
	Status               string           `json:"status"`
	Title                string           `json:"title,omitempty"`
	LastError            string           `json:"lastError,omitempty"`
	Visible              bool             `json:"visible"`
	OpenclawGatewayReady bool             `json:"-"`
	PermissionModeID     string           `json:"permissionModeId,omitempty"`
	Settings             *SessionSettings `json:"settings,omitempty"`
	CreatedAtUnixMS      int64            `json:"createdAtUnixMs"`
	UpdatedAtUnixMS      int64            `json:"updatedAtUnixMs"`
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
	Provider           string                    `json:"provider"`
	ProviderSessionID  string                    `json:"providerSessionId,omitempty"`
	Status             string                    `json:"status"`
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

type SessionError struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	DebugMessage string `json:"debugMessage,omitempty"`
}

type StartResult struct {
	Session Session       `json:"session"`
	Error   *SessionError `json:"error,omitempty"`
}

type CloseResult struct {
	AgentSessionID string `json:"agentSessionId"`
	Disconnected   bool   `json:"disconnected"`
}

type ExecResult struct {
	AgentSessionID string `json:"agentSessionId"`
	Status         string `json:"status"`
	TurnID         string `json:"turnId,omitempty"`
	Accepted       bool   `json:"accepted"`
	SessionStatus  string `json:"sessionStatus"`
}

type CancelResult struct {
	AgentSessionID string `json:"agentSessionId"`
	Canceled       bool   `json:"canceled"`
}

type SubmitInteractiveResult struct {
	AgentSessionID string  `json:"agentSessionId"`
	RequestID      string  `json:"requestId"`
	Accepted       bool    `json:"accepted"`
	OptionID       string  `json:"optionId,omitempty"`
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
