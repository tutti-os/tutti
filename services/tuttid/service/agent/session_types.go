package agent

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	tuttimodeactivationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	claudecodeservice "github.com/tutti-os/tutti/services/tuttid/service/claudecode"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
)

type Service struct {
	Runtime                        RuntimeController
	AnalyticsReporter              reporterservice.Reporter
	AvailabilityChecker            ProviderAvailabilityChecker
	ModelCatalog                   AgentModelCatalog
	ModelCapabilities              ModelCapabilitiesResolver
	AgentTargetStore               AgentTargetStore
	WorkspaceAgentResolver         WorkspaceAgentResolver
	SessionReader                  SessionReader
	UserProjectReader              UserProjectReader
	MessageReader                  MessageReader
	ExternalImportStore            agentactivitybiz.Repository
	TurnStore                      TurnStore
	RuntimeOperationStore          RuntimeOperationStore
	SubmitClaimStore               SubmitClaimStore
	RuntimeOperationEventPublisher RuntimeOperationEventPublisher
	AutomationRuleOverrides        AutomationRuleSessionOverrideWriter
	TuttiModeActivations           TuttiModeActivationCoordinator
	SourceSessionDeletions         SourceSessionDeletionCoordinator
	SessionDeletionEvents          SessionDeletionEventPublisher
	TurnCancelObserver             TurnCancelObserver
	RuntimeOperationClock          func() time.Time
	RuntimeOperationOwner          string
	SessionDirectoryAllocator      SessionDirectoryAllocator
	PromptAttachmentStore          PromptAttachmentStore
	RuntimePreparer                runtimeprep.Preparer
	ComputerUseAvailable           func() bool
	CapabilityLister               ComposerCapabilityLister
	ExtensionComposerProfiles      ExtensionComposerProfileResolver
	ProviderAvailabilityCacheTTL   time.Duration
	CapabilityCatalogCacheTTL      time.Duration
	LiveModelCacheTTL              time.Duration
	LiveModelDiscoveryDeleteDelay  time.Duration
	skillOptionsCache              *composerSkillOptionsCache
	providerAvailabilityCache      *providerAvailabilityCache
	capabilityCatalogCache         *composerCapabilityCatalogCache
	liveModelCache                 *composerLiveModelCache
	claudeStartupLock              *claudecodeservice.StartupGate
	liveModelDiscoveryMu           sync.Mutex
	liveModelDiscoveryAttempted    map[string]struct{}
	liveModelInvalidatedAtUnixMS   map[string]int64
	liveModelDiscoverySessions     map[string]liveModelDiscoverySessionRef
	liveModelDiscoveryGroup        singleflight.Group
	// liveModelPersistedScanMissAtUnixMS memoizes, per live-model cache key,
	// when the persisted-session fallback scan last found nothing, so the
	// full session scan is not repeated on every composer-options fetch.
	liveModelPersistedScanMissAtUnixMS map[string]int64
	// modelPlanBinding wires the optional workspace model access plan
	// integration; see ConfigureModelPlanBinding.
	modelPlanBinding modelPlanBindingRuntime
}

type AutomationRuleSessionOverrideWriter interface {
	SetSessionOverride(context.Context, automationrulebiz.SessionOverride) (automationrulebiz.SessionOverride, error)
}

type TuttiModeActivationCoordinator interface {
	Get(context.Context, string, string) (*tuttimodeactivationbiz.Activation, error)
	List(context.Context, string, []string) (map[string]tuttimodeactivationbiz.Activation, error)
	Set(context.Context, tuttimodeactivationservice.SetInput) (tuttimodeactivationservice.SetResult, error)
	SnapshotForNewTurn(context.Context, string, string) (tuttimodeactivationbiz.TurnSnapshot, error)
	ExistingTurnSnapshot(context.Context, string, string, string) (tuttimodeactivationbiz.TurnSnapshot, error)
	BindTurnSnapshot(context.Context, string, string, string, tuttimodeactivationbiz.TurnSnapshot) (tuttimodeactivationbiz.TurnSnapshot, bool, error)
	AcceptTurnSnapshot(context.Context, string, string, string) (bool, error)
	AbandonTurnSnapshot(context.Context, string, string, string, tuttimodeactivationbiz.TurnSnapshot) (bool, error)
	DeleteSessionState(context.Context, string, string) error
}

type SubmitClaimStore interface {
	PrepareSubmitClaim(context.Context, agentactivitybiz.SubmitClaimPrepare) (agentactivitybiz.SubmitClaim, bool, error)
	GetSubmitClaim(context.Context, string, string, string) (agentactivitybiz.SubmitClaim, bool, error)
	AcceptSubmitClaim(context.Context, string, string, string, string, int64) (agentactivitybiz.SubmitClaim, bool, error)
	DeleteSubmitClaim(context.Context, string, string, string) (bool, error)
	FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
}

type RuntimeController interface {
	Cancel(context.Context, RuntimeCancelInput) (RuntimeCancelResult, error)
	GoalControl(context.Context, RuntimeGoalControlInput) (RuntimeGoalControlResult, error)
	CanResume(RuntimeResumeInput) bool
	Close(context.Context, RuntimeCloseInput) error
	// Exec acknowledges provider dispatch only. For a new turn, a non-nil
	// error or Accepted=false means the controller did not pass beginTurn and
	// did not dispatch provider work. Guidance acts on an existing turn and
	// cannot make that guarantee, so the service treats guidance errors as
	// delivery-unknown. Accepted=true is not a durable provenance receipt.
	Exec(context.Context, RuntimeExecInput) (RuntimeExecResult, error)
	// DurablyReportSubmitProvenance is the required post-dispatch durability
	// barrier. It returns only after the exact client submit is atomically
	// queryable with its canonical turn, behind all earlier runtime reports in
	// the same FIFO. The service calls it before accepting snapshots or claims.
	DurablyReportSubmitProvenance(context.Context, RuntimeSubmitProvenanceInput) error
	Resume(context.Context, RuntimeResumeInput) (ProviderRuntimeSession, error)
	Session(workspaceID string, agentSessionID string) (ProviderRuntimeSession, bool)
	SetTitle(context.Context, RuntimeSetTitleInput) (ProviderRuntimeSession, error)
	SetVisible(context.Context, RuntimeSetVisibleInput) (ProviderRuntimeSession, error)
	Sessions(workspaceID string) []ProviderRuntimeSession
	Start(context.Context, RuntimeStartInput) (ProviderRuntimeSession, error)
	SubmitInteractive(context.Context, RuntimeSubmitInteractiveInput) (RuntimeSubmitInteractiveResult, error)
	InteractiveDisposition(workspaceID string, rootAgentSessionID string, agentSessionID string, turnID string, requestID string) RuntimeInteractiveDisposition
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

type WorkspaceAgentResolver interface {
	Resolve(context.Context, string, string) (workspaceagentbiz.Resolved, error)
}

type ComposerCapabilityLister interface {
	ListComposerCapabilityOptions(context.Context, string, string, []ComposerSkillOption) ([]ComposerCapabilityOption, []string)
}

type ExtensionComposerProfileResolver interface {
	ResolveExtensionComposerProfile(context.Context, string) (ExtensionComposerProfile, error)
}

type ExtensionComposerProfile struct {
	Skills *ExtensionComposerSkillProfile
}

type ExtensionComposerSkillProfile struct {
	Invocation    string
	TriggerPrefix string
	Roots         []ExtensionComposerSkillRoot
}

type ExtensionComposerSkillRoot struct {
	Scope string
	Path  string
}

type Session struct {
	ID                   string
	Kind                 string
	RootAgentSessionID   string
	RootTurnID           string
	ParentAgentSessionID string
	ParentTurnID         string
	ParentToolCallID     string
	UserID               string
	AgentTargetID        string
	Provider             string
	ProviderSessionID    string
	Cwd                  string
	Visible              bool
	Resumable            bool
	Settings             *ComposerSettings
	PermissionConfig     PermissionConfig
	Title                *string
	PinnedAtUnixMS       int64
	CreatedAt            time.Time
	UpdatedAt            *time.Time
	EndedAt              *time.Time
	Metadata             agentactivitybiz.SessionMetadata
	// Protocol v2 turn state (agent-gui refactor plan): the session keeps an
	// activeTurnId reference; phase/outcome/error live on the turn entity.
	ActiveTurnID           string
	ActiveTurn             *agentactivitybiz.Turn
	LatestTurn             *agentactivitybiz.Turn
	LatestTurnInteractions []agentactivitybiz.Interaction
	PendingInteractions    []agentactivitybiz.Interaction
	TuttiModeActivation    *tuttimodeactivationbiz.Activation
}

type ListSessionsInput struct {
	AgentTargetID string
	Cursor        string
	SearchQuery   string
	Limit         int
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

type ListSessionSectionDeletionCandidatesInput struct {
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
	SessionIDs []string
}

type DeleteSessionsBatchResult struct {
	RemovedMessages   int
	RemovedSessions   int
	RemovedSessionIDs []string
}

type ListPinnedSessionPageInput struct {
	Cursor        string
	Limit         int
	AgentTargetID string
}

type SessionSectionsPage struct {
	WorkspaceID string
	Pinned      SessionPage
	Sections    []SessionSection
}

type SessionPage struct {
	Sessions   []Session
	HasMore    bool
	TotalCount int
	NextCursor string
}

type SessionSection struct {
	Kind        string
	SectionKey  string
	UserProject *userprojectbiz.Project
	Sessions    []Session
	HasMore     bool
	TotalCount  int
	NextCursor  string
}

type PersistedSession struct {
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
	Cwd                    string
	Settings               ComposerSettings
	Metadata               agentactivitybiz.SessionMetadata
	InternalRuntimeContext map[string]any
	Title                  string
	PinnedAtUnixMS         int64
	LastEventUnixMS        int64
	StartedAtUnixMS        int64
	EndedAtUnixMS          int64
	CreatedAtUnixMS        int64
	UpdatedAtUnixMS        int64
	ActiveTurnID           string
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
	SessionDeleted(ctx context.Context, workspaceID string, agentSessionID string) (bool, error)
}

type ChildSessionReader interface {
	ListChildSessions(context.Context, string, string) ([]PersistedSession, error)
}

type SessionDetail struct {
	Session       Session
	ChildSessions []Session
}

type SessionSectionReader interface {
	ListSessionSection(context.Context, agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool)
}

type SessionSectionDeletionCandidateReader interface {
	ListSessionSectionDeletionCandidates(context.Context, agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool)
}

type SessionBatchDeleter interface {
	// DeleteSessionsBatch is a persistence-only fallback for isolated stores.
	// Production deletion uses SourceSessionDeletionCoordinator so workflow
	// policy remains in the Tutti mode plan service.
	DeleteSessionsBatch(context.Context, agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error)
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
	// ClearSessions is a persistence-only fallback for isolated stores.
	ClearSessions(context.Context, string) (ClearSessionsResult, error)
}

type SessionDeleter interface {
	// DeleteSession is a persistence-only fallback for isolated stores.
	DeleteSession(context.Context, string, string) (bool, error)
}

type SessionPinUpdater interface {
	UpdateSessionPinned(context.Context, string, string, bool) (PersistedSession, bool, error)
}

type SessionTitleUpdater interface {
	UpdateSessionTitle(context.Context, string, string, string) (PersistedSession, bool, error)
}

// ProviderRuntimeSession is an adapter/controller-private snapshot. Its
// status, lifecycle and runtime context are provider observations only; they
// must never be exposed as, or used to overwrite, the durable Session/Turn/
// Interaction entities.
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
	Metadata               agentactivitybiz.SessionMetadata
	InternalRuntimeContext map[string]any
	// RecreateIfMissing lets the runtime start a fresh provider session in place
	// when the existing one can't be restored locally (imported conversations),
	// instead of surfacing a non-recoverable restore error.
	RecreateIfMissing bool
}

type RuntimeExecInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	// ClientSubmitID is the typed idempotency/provenance identity. Metadata is
	// diagnostic context only and must not carry this business key.
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

type RuntimeSubmitProvenanceInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	ClientSubmitID string
	Content        []PromptContentBlock
	DisplayPrompt  string
	Guidance       bool
}

// TuttiModeTurnSnapshot is the immutable activation revision observed by one
// turn. It is an execution input, not a reconstruction from capability refs.
type TuttiModeTurnSnapshot struct {
	ActivationID string
	RevisionID   string
	Revision     int64
	State        string
	Source       string
	// OrchestrationIntensity is the planning strength captured by the exact
	// activation revision this turn observed.
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
	AgentSessionID string
	AgentTargetID  string
	// WorkspaceAgentRevision and HarnessAgentTargetID identify the immutable
	// user-facing Agent definition and underlying Harness selected for launch.
	// Legacy system targets leave the revision zero and use AgentTargetID as the
	// Harness id.
	WorkspaceAgentRevision    int64
	HarnessAgentTargetID      string
	AgentName                 string
	AgentDescription          string
	AgentDefaultModel         string
	AgentInstructions         string
	AgentCallConditions       []string
	AgentCapabilitiesExplicit bool
	AgentSkills               []string
	AgentTools                []string
	// AutomationRuleOverride is persisted after the runtime session starts but
	// before its initial turn executes, so the first completion observes the
	// session-local rule selection. Nil inherits enabled workspace rules.
	AutomationRuleOverride *automationrulebiz.SessionOverride
	// InitialTuttiModeActivation applies the independent, session-scoped Tutti
	// mode activation before the first turn starts. CapabilityRefs remain audit
	// records and never imply this intent.
	InitialTuttiModeActivation *TuttiModeActivationIntent
	// ResolvedModelPlan is a daemon-only exact plan override supplied by a
	// WorkspaceAgent resolver. It may contain a credential and must never be
	// serialized into runtime context or transport responses.
	ResolvedModelPlan *modelplanbiz.Plan
	// IgnoreModelPlanBinding forces provider-native credentials and model
	// discovery for internal probes. It is daemon-only and must not be exposed
	// as a user-facing session setting.
	IgnoreModelPlanBinding bool
	Provider               string
	CapabilityRefs         []CapabilityReference
	InitialContent         []PromptContentBlock
	InitialDisplayPrompt   string
	// ClientSubmitID owns submit claiming and durable provenance; Metadata
	// contains diagnostics only.
	ClientSubmitID   string
	Metadata         map[string]any
	Title            *string
	Cwd              *string
	PermissionModeID *string
	// StrictPermissionMode rejects an explicit unsupported permission mode
	// instead of applying the provider default. It is used by unattended
	// automation so a typo cannot silently broaden authority.
	StrictPermissionMode bool
	Model                *string
	ModelPlanID          *string
	PlanMode             *bool
	BrowserUse           *bool
	ComputerUse          *bool
	ProviderTargetRef    map[string]any
	ReasoningEffort      *string
	// ReasoningIntensity is an Issue-owned 0-100 strength request. When an
	// explicit ReasoningEffort is absent, Create compiles it against the
	// selected model's ordered reasoning-effort catalog. It is daemon-only and
	// is not persisted as a per-session user setting.
	ReasoningIntensity     *int
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

type TuttiModeActivationIntent struct {
	State  string
	Source string
	// OrchestrationIntensity is optional; nil uses the daemon default.
	OrchestrationIntensity *int
}

type SessionSkillBundle struct {
	Name  string
	Files map[string]string
}

type SendInput struct {
	CapabilityRefs []CapabilityReference
	Content        []PromptContentBlock
	DisplayPrompt  string
	// ClientSubmitID owns submit claiming and durable provenance; Metadata
	// contains diagnostics only.
	ClientSubmitID string
	Metadata       map[string]any
	Guidance       bool
}

type CapabilityReference struct {
	Capability string
	Source     string
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

type SubmitInteractiveInput struct {
	TurnID   string
	Action   *string
	OptionID *string
	Payload  map[string]any
}

type SubmitPlanDecisionInput struct {
	PromptKind     string
	Action         string
	IdempotencyKey string
}

type StreamInput struct {
	WorkspaceID    string
	AgentSessionID string
}

type WaitInput struct {
	WorkspaceID    string
	AgentSessionID string
	AfterVersion   *uint64
	MessageLimit   int
	SkipMessages   bool
	Timeout        time.Duration
}

type WaitReason string

const (
	WaitReasonReady           WaitReason = "ready"
	WaitReasonWaiting         WaitReason = "waiting"
	WaitReasonWaitingApproval WaitReason = "waiting_approval"
	WaitReasonWaitingInput    WaitReason = "waiting_input"
	WaitReasonCompleted       WaitReason = "completed"
	WaitReasonFailed          WaitReason = "failed"
	WaitReasonCanceled        WaitReason = "canceled"
	WaitReasonTimeout         WaitReason = "timeout"
)

type WaitResult struct {
	Session        Session
	Messages       []SessionMessage
	LatestVersion  uint64
	HasMore        bool
	Reason         WaitReason
	TimedOut       bool
	EffectiveAfter uint64
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
