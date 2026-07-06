package agent

import (
	"context"
	"sync"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
)

type Service struct {
	Runtime                       RuntimeController
	AnalyticsReporter             reporterservice.Reporter
	AvailabilityChecker           ProviderAvailabilityChecker
	ModelCatalog                  AgentModelCatalog
	AgentTargetStore              AgentTargetStore
	SessionReader                 SessionReader
	UserProjectReader             UserProjectReader
	MessageReader                 MessageReader
	ExternalImportStore           agentactivitybiz.Repository
	SessionDirectoryAllocator     SessionDirectoryAllocator
	PromptAttachmentStore         PromptAttachmentStore
	RuntimePreparer               agentsidecarservice.Preparer
	CapabilityLister              ComposerCapabilityLister
	ProviderAvailabilityCacheTTL  time.Duration
	CapabilityCatalogCacheTTL     time.Duration
	LiveModelCacheTTL             time.Duration
	LiveModelDiscoveryDeleteDelay time.Duration
	skillOptionsCache             *composerSkillOptionsCache
	providerAvailabilityCache     *providerAvailabilityCache
	capabilityCatalogCache        *composerCapabilityCatalogCache
	liveModelCache                *composerLiveModelCache
	claudeStartupLock             *claudeStartupSerializer
	liveModelDiscoveryMu          sync.Mutex
	liveModelDiscoveryAttempted   map[string]struct{}
	liveModelInvalidatedAtUnixMS  map[string]int64
}

type StaleTurnResumeReconciler interface {
	ReconcileStaleTurnOnResume(context.Context, PersistedSession) error
}

type RuntimeController interface {
	Cancel(context.Context, RuntimeCancelInput) (RuntimeCancelResult, error)
	GoalControl(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error)
	CanResume(RuntimeResumeInput) bool
	Close(context.Context, RuntimeCloseInput) error
	Exec(context.Context, RuntimeExecInput) (RuntimeExecResult, error)
	Resume(context.Context, RuntimeResumeInput) (RuntimeSession, error)
	Session(workspaceID string, agentSessionID string) (RuntimeSession, bool)
	SetVisible(context.Context, RuntimeSetVisibleInput) (RuntimeSession, error)
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

type AgentTargetStore interface {
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
}

type ComposerCapabilityLister interface {
	ListComposerCapabilityOptions(context.Context, string, string, []ComposerSkillOption) ([]ComposerCapabilityOption, []string)
}

type Session struct {
	ID                 string
	UserID             string
	AgentTargetID      string
	Provider           string
	ProviderSessionID  string
	Cwd                string
	Status             string
	TurnLifecycle      *TurnLifecycle
	SubmitAvailability *SubmitAvailability
	Visible            bool
	Resumable          bool
	Settings           *ComposerSettings
	PermissionConfig   PermissionConfig
	RuntimeContext     map[string]any
	Title              *string
	PinnedAtUnixMS     int64
	CreatedAt          time.Time
	UpdatedAt          *time.Time
	EndedAt            *time.Time
	LastError          *string
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
}

type SessionListPage struct {
	Sessions   []Session
	HasMore    bool
	NextCursor string
}

type ListSessionSectionsInput struct {
	LimitPerSection int
	AgentTargetID   string
}

type ListSessionSectionPageInput struct {
	SectionKey    string
	Cursor        string
	Limit         int
	AgentTargetID string
}

type SessionSectionsPage struct {
	WorkspaceID string
	Sections    []SessionSection
}

type SessionSection struct {
	Kind        string
	SectionKey  string
	UserProject *userprojectbiz.Project
	Sessions    []Session
	HasMore     bool
	NextCursor  string
}

type PersistedSession struct {
	ID                string
	WorkspaceID       string
	Origin            string
	UserID            string
	AgentTargetID     string
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
	LastEventUnixMS   int64
	StartedAtUnixMS   int64
	EndedAtUnixMS     int64
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

type SessionSectionReader interface {
	ListSessionSection(context.Context, agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool)
}

type UserProjectReader interface {
	List(context.Context) ([]userprojectbiz.Project, error)
}

type ClearSessionsResult struct {
	RemovedMessages   int
	RemovedSessions   int
	RemovedSessionIDs []string
}

type SessionClearer interface {
	ClearSessions(context.Context, string) (ClearSessionsResult, error)
}

type SessionDeleter interface {
	DeleteSession(context.Context, string, string) (bool, error)
}

type SessionPinUpdater interface {
	UpdateSessionPinned(context.Context, string, string, bool) (PersistedSession, bool, error)
}

type RuntimeSession struct {
	ID                 string
	WorkspaceID        string
	UserID             string
	AgentTargetID      string
	Provider           string
	ProviderSessionID  string
	Cwd                string
	Env                []string
	Settings           *ComposerSettings
	RuntimeContext     map[string]any
	Status             string
	TurnLifecycle      *TurnLifecycle
	SubmitAvailability *SubmitAvailability
	PendingInteractive *RuntimeInteractivePrompt
	Visible            bool
	Title              string
	LastError          string
	PinnedAtUnixMS     int64
	CreatedAtUnixMS    int64
	UpdatedAtUnixMS    int64
}

type RuntimeInteractivePrompt struct {
	Kind      string
	RequestID string
	ToolName  string
	Status    string
	Input     map[string]any
	Output    map[string]any
	Error     map[string]any
	Metadata  map[string]any
}

type RuntimeStartInput struct {
	WorkspaceID            string
	AgentSessionID         string
	AgentTargetID          string
	Provider               string
	Cwd                    string
	Env                    []string
	Title                  string
	PermissionModeID       string
	Model                  string
	PlanMode               bool
	BrowserUse             *bool
	ComputerUse            *bool
	ProviderTargetRef      map[string]any
	RuntimeContext         map[string]any
	ReasoningEffort        string
	Speed                  string
	ConversationDetailMode string
	Visible                *bool
}

type RuntimeResumeInput struct {
	WorkspaceID       string
	AgentSessionID    string
	AgentTargetID     string
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
	RuntimeContext    map[string]any
	// RecreateIfMissing lets the runtime start a fresh provider session in place
	// when the existing one can't be restored locally (imported conversations),
	// instead of surfacing a non-recoverable restore error.
	RecreateIfMissing bool
}

type RuntimeExecInput struct {
	WorkspaceID    string
	AgentSessionID string
	Content        []PromptContentBlock
	DisplayPrompt  string
	Metadata       map[string]any
	Guidance       bool
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
	WorkspaceID    string
	AgentSessionID string
	Reason         string
}

type RuntimeCancelResult struct {
	AgentSessionID string
	Canceled       bool
}

type RuntimeGoalControlInput struct {
	WorkspaceID    string
	AgentSessionID string
	Action         string
	Objective      string
}

type RuntimeGoalControlResult struct {
	AgentSessionID string
	Goal           map[string]any
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

type RuntimeSetVisibleInput struct {
	WorkspaceID    string
	AgentSessionID string
	Visible        bool
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

type RuntimeStreamEvent struct {
	EventType string
	Data      any
}

type CreateSessionInput struct {
	AgentSessionID         string
	AgentTargetID          string
	Provider               string
	InitialContent         []PromptContentBlock
	InitialDisplayPrompt   string
	Metadata               map[string]any
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
	ExtraSkills            []SessionSkillBundle
	// ExternalRolloutSourcePath is the absolute path to the original provider
	// CLI rollout/transcript file this session was imported from, when known.
	// Populated from the persisted session's RuntimeContext when resuming an
	// imported conversation (see createSessionInputFromPersisted); empty for
	// brand-new sessions.
	ExternalRolloutSourcePath string
}

type SessionSkillBundle struct {
	Name  string
	Files map[string]string
}

type SendInput struct {
	Content       []PromptContentBlock
	DisplayPrompt string
	Metadata      map[string]any
	Guidance      bool
}

type SendInputResult struct {
	Session            Session
	TurnID             string
	TurnLifecycle      TurnLifecycle
	SubmitAvailability SubmitAvailability
}

type PromptContentBlock struct {
	Type         string `json:"type"`
	Text         string `json:"text,omitempty"`
	MimeType     string `json:"mimeType,omitempty"`
	Data         string `json:"data,omitempty"`
	AttachmentID string `json:"attachmentId,omitempty"`
	Name         string `json:"name,omitempty"`
	Path         string `json:"path,omitempty"`
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
