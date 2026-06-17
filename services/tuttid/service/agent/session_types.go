package agent

import (
	"context"
	"time"

	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
)

type Service struct {
	Runtime                   RuntimeController
	AvailabilityChecker       ProviderAvailabilityChecker
	ModelCatalog              AgentModelCatalog
	SessionReader             SessionReader
	MessageReader             MessageReader
	SessionDirectoryAllocator SessionDirectoryAllocator
	PromptAttachmentStore     PromptAttachmentStore
	RuntimePreparer           agentsidecarservice.Preparer
	skillOptionsCache         *composerSkillOptionsCache
}

type StaleTurnResumeReconciler interface {
	ReconcileStaleTurnOnResume(context.Context, PersistedSession) error
}

type RuntimeController interface {
	Cancel(context.Context, RuntimeCancelInput) (RuntimeCancelResult, error)
	CanResume(RuntimeResumeInput) bool
	Close(context.Context, RuntimeCloseInput) error
	Exec(context.Context, RuntimeExecInput) (RuntimeExecResult, error)
	Resume(context.Context, RuntimeResumeInput) (RuntimeSession, error)
	Session(workspaceID string, agentSessionID string) (RuntimeSession, bool)
	Sessions(workspaceID string) []RuntimeSession
	Start(context.Context, RuntimeStartInput) (RuntimeSession, error)
	SubmitInteractive(context.Context, RuntimeSubmitInteractiveInput) error
	Subscribe(workspaceID string, agentSessionID string) (<-chan RuntimeStreamEvent, func(), bool)
	UpdateSettings(context.Context, RuntimeUpdateSettingsInput) error
	ValidatePromptContent(context.Context, RuntimeExecInput) error
}

type SessionDirectoryAllocator interface {
	CreateSessionDirectory(context.Context) (string, error)
}

type Session struct {
	ID                string
	Provider          string
	ProviderSessionID string
	Cwd               string
	Status            string
	Visible           bool
	Resumable         bool
	Settings          *ComposerSettings
	PermissionConfig  PermissionConfig
	RuntimeContext    map[string]any
	Title             *string
	PinnedAtUnixMS    int64
	CreatedAt         time.Time
	UpdatedAt         *time.Time
	EndedAt           *time.Time
	LastError         *string
}

type CancelReason string

const (
	CancelReasonActiveTurnCanceled  CancelReason = "active_turn_canceled"
	CancelReasonNoActiveTurn        CancelReason = "no_active_turn"
	CancelReasonStaleTurnReconciled CancelReason = "stale_turn_reconciled"
)

type CancelSessionResult struct {
	Session  Session
	Canceled bool
	Reason   CancelReason
}

type ListSessionsInput struct {
	SearchQuery string
	Limit       int
	VisibleOnly bool
}

type PersistedSession struct {
	ID                string
	WorkspaceID       string
	Provider          string
	ProviderSessionID string
	Cwd               string
	Settings          ComposerSettings
	RuntimeContext    map[string]any
	Status            string
	CurrentPhase      string
	Visible           bool
	Title             string
	LastError         string
	PinnedAtUnixMS    int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type SessionMessage struct {
	ID                uint64
	AgentSessionID    string
	MessageID         string
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
	Version           uint64
}

type SessionReader interface {
	GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool)
	ListSessions(workspaceID string) ([]PersistedSession, bool)
}

type SessionDeleter interface {
	DeleteSession(context.Context, string, string) (bool, error)
}

type SessionPinUpdater interface {
	UpdateSessionPinned(context.Context, string, string, bool) (PersistedSession, bool, error)
}

type RuntimeSession struct {
	ID                string
	WorkspaceID       string
	Provider          string
	ProviderSessionID string
	Cwd               string
	Env               []string
	Settings          *ComposerSettings
	RuntimeContext    map[string]any
	Status            string
	Visible           bool
	Title             string
	LastError         string
	PinnedAtUnixMS    int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type RuntimeStartInput struct {
	WorkspaceID      string
	AgentSessionID   string
	Provider         string
	Cwd              string
	Env              []string
	Title            string
	PermissionModeID string
	Model            string
	PlanMode         bool
	BrowserUse       *bool
	ReasoningEffort  string
	Speed            string
	Visible          *bool
}

type RuntimeResumeInput struct {
	WorkspaceID       string
	AgentSessionID    string
	Provider          string
	ProviderSessionID string
	Cwd               string
	Env               []string
	Title             string
	Status            string
	Settings          ComposerSettings
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
	Visible           *bool
}

type RuntimeExecInput struct {
	WorkspaceID    string
	AgentSessionID string
	Content        []PromptContentBlock
	DisplayPrompt  string
}

type RuntimeExecResult struct {
	AgentSessionID string
	Status         string
	TurnID         string
	Accepted       bool
	SessionStatus  string
}

type RuntimeCancelInput struct {
	WorkspaceID    string
	AgentSessionID string
	Reason         string
}

type RuntimeCancelResult struct {
	AgentSessionID string
	Canceled       bool
}

type RuntimeCloseInput struct {
	WorkspaceID    string
	AgentSessionID string
}

type RuntimeSubmitInteractiveInput struct {
	WorkspaceID    string
	AgentSessionID string
	RequestID      string
	Action         string
	OptionID       string
	Payload        map[string]any
}

type RuntimeUpdateSettingsInput struct {
	WorkspaceID    string
	AgentSessionID string
	Settings       ComposerSettingsPatch
}

type ComposerSettingsPatch struct {
	Model            *string
	PermissionModeID *string
	PlanMode         *bool
	BrowserUse       *bool
	ReasoningEffort  *string
	Speed            *string
}

type RuntimeStreamEvent struct {
	EventType string
	Data      any
}

type CreateSessionInput struct {
	AgentSessionID       string
	Provider             string
	InitialContent       []PromptContentBlock
	InitialDisplayPrompt string
	Title                *string
	Cwd                  *string
	PermissionModeID     *string
	Model                *string
	PlanMode             *bool
	BrowserUse           *bool
	ReasoningEffort      *string
	Speed                *string
	Visible              *bool
	ExtraSkills          []SessionSkillBundle
}

type SessionSkillBundle struct {
	Name  string
	Files map[string]string
}

type SendInput struct {
	Content       []PromptContentBlock
	DisplayPrompt string
}

type PromptContentBlock struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	MimeType     string `json:"mimeType,omitempty"`
	Data         string `json:"data,omitempty"`
	AttachmentID string `json:"attachmentId,omitempty"`
	Name         string `json:"name,omitempty"`
}

type PromptAttachment struct {
	AttachmentID string
	MimeType     string
	Data         string
}

type SubmitInteractiveInput struct {
	Action   *string
	OptionID *string
	Payload  map[string]any
}

type StreamInput struct {
	WorkspaceID    string
	AgentSessionID string
}

type StreamEvent struct {
	OccurredAt time.Time
	Payload    map[string]any
	Seq        int64
	Type       string
}

type EventStream struct {
	Events      <-chan StreamEvent
	Unsubscribe func()
}
