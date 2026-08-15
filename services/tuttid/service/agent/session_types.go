package agent

import (
	"context"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	market "github.com/tutti-os/tutti/packages/connector/host"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
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
	ReplayMode                     bool
	ModelCapabilities              ModelCapabilitiesResolver
	AgentTargetStore               AgentTargetStore
	SessionInitializer             SessionInitializer
	WorkspaceAgentResolver         WorkspaceAgentResolver
	SessionReader                  SessionReader
	SessionPurgeStore              agenthost.SessionPurgeStore
	SessionDeletionGuard           agenthost.SessionDeletionGuard
	AgentSessionResourceReleaser   AgentSessionResourceReleaser
	UserProjectReader              UserProjectReader
	MessageReader                  MessageReader
	ExternalImportStore            agentactivitybiz.Repository
	TurnStore                      TurnStore
	TurnSummaryReader              agentactivitybiz.SessionTurnSummaryReader
	RuntimeOperationStore          RuntimeOperationStore
	GoalStateStore                 GoalStateStore
	GoalGenerationFenceStore       agenthost.GoalGenerationFenceStore
	CommitObserver                 agenthost.CommitObserver
	GoalReconcileInboxStore        GoalReconcileInboxStore
	SubmitClaimStore               SubmitClaimStore
	RuntimeOperationEventPublisher RuntimeOperationEventPublisher
	TuttiModeActivations           TuttiModeActivationPort
	TuttiModeSourceActivity        TuttiModeSourceActivityObserver
	TurnCancelObserver             TurnCancelObserver
	RuntimeOperationClock          func() time.Time
	RuntimeOperationOwner          string
	StaleTurnSettler               agenthost.StaleTurnSettler
	GoalOperationOwner             string
	GoalOperationClock             func() time.Time
	GoalOperationAttemptTimeout    time.Duration
	GoalOperationRecoveryBudget    time.Duration
	GoalOperationMaxAttempts       int
	GoalOperationDispatchDeadline  time.Duration
	SessionDirectoryAllocator      SessionDirectoryAllocator
	WorktreeStateDir               string
	WorkspaceIDs                   func(context.Context) ([]string, error)
	PromptAttachmentStore          PromptAttachmentStore
	RuntimePreparer                runtimeprep.Preparer
	ConnectorRuntime               ConnectorRuntime
	ConnectorCapabilities          ConnectorCapabilityResolver
	ModelGateway                   ModelGatewayRegistry
	BrowserUseAvailable            func() bool
	ComputerUseAvailable           func() bool
	CapabilityLister               ComposerCapabilityLister
	ConnectorMarketSnapshots       market.SnapshotReader
	ExtensionComposerProfiles      ExtensionComposerProfileResolver
	AgentComposerDefaultsReader    AgentComposerDefaultsReader
	DesktopPreferencesReader       DesktopPreferencesReader
	ProviderAvailabilityCacheTTL   time.Duration
	CapabilityCatalogCacheTTL      time.Duration
	LiveModelCacheTTL              time.Duration
	liveModelDiscoveryWaitTimeout  time.Duration
	GeneratedFilesClock            func() time.Time
	LiveModelDiscoveryDeleteDelay  time.Duration
	skillOptionsCache              *composerSkillOptionsCache
	providerAvailabilityCache      *providerAvailabilityCache
	capabilityCatalogCache         *composerCapabilityCatalogCache
	capabilityCatalogGroup         singleflight.Group
	liveModelCache                 *composerLiveModelCache
	claudeStartupLock              *claudecodeservice.StartupGate
	liveModelDiscoveryMu           sync.Mutex
	liveModelDiscoveryAttempted    map[string]struct{}
	liveModelInvalidatedAtUnixMS   map[string]int64
	liveModelDiscoverySessions     map[string]liveModelDiscoverySessionRef
	liveModelDiscoveryGroup        singleflight.Group
	sessionSettingsMu              sync.Mutex
	sessionSettingsLocks           map[string]*serviceSessionSettingsLock
	sessionSettingsState           *serviceSessionSettingsState
	applicationHostMu              sync.Mutex
	applicationHost                *agenthost.Host
	applicationHostProvider        func() *agenthost.Host
	hostRuntimePreparation         serviceHostRuntimePreparationSupport
	worktreeIsolationMu            sync.RWMutex
	worktreeIsolationLock          *sync.RWMutex
	generatedFilesCacheMu          sync.Mutex
	generatedFilesCache            map[string]generatedFilesCacheEntry
	// liveModelPersistedScanMissAtUnixMS memoizes, per live-model cache key,
	// when the persisted-session fallback scan last found nothing, so the
	// full session scan is not repeated on every composer-options fetch.
	liveModelPersistedScanMissAtUnixMS map[string]int64
	// modelPlanBinding wires the optional workspace model access plan
	// integration; see ConfigureModelPlanBinding.
	modelPlanBinding modelPlanBindingRuntime
}

// ConnectorRuntime is the tuttid-owned projection of the active Connector
// runtime into Agent session preparation. Bindings isolate one local Agent
// session; they do not express Connector-level permissions.
type ConnectorRuntime interface {
	RoutingHints() []runtimeprep.ConnectorRoutingHint
	BindSession(string, string) (runtimeprep.ConnectorAgentContext, error)
	RevokeSession(string, string)
	RevokeAll()
}

type ConnectorCapabilityInput struct {
	WorkspaceID       string
	AgentSessionID    string
	AgentTargetID     string
	Provider          string
	Cwd               string
	Env               []string
	ProviderTargetRef map[string]any
	PermissionModeID  string
	Settings          ComposerSettings
}

type ConnectorCapabilityResolver interface {
	ConnectorHTTPMCPSupported(context.Context, ConnectorCapabilityInput) (bool, error)
}

type TuttiModeSourceActivity struct {
	WorkspaceID      string
	SessionID        string
	Kind             string
	ActivityID       string
	OccurredAtUnixMS int64
}

type TuttiModeSourceActivityObserver interface {
	ObserveTuttiModeSourceActivity(context.Context, TuttiModeSourceActivity) error
}

type GoalReconcileInboxStore = agenthost.GoalReconcileInboxStore

type TuttiModeActivationPort interface {
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
	RejectSubmitClaim(context.Context, string, string, string, string, int64) (agentactivitybiz.SubmitClaim, bool, error)
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
	PublishSessionInitialization(context.Context, RuntimeSessionInitializationPublishInput) (ProviderRuntimeSession, error)
	Resume(context.Context, RuntimeResumeInput) (ProviderRuntimeSession, error)
	Session(workspaceID string, agentSessionID string) (ProviderRuntimeSession, bool)
	SetTitle(context.Context, RuntimeSetTitleInput) (ProviderRuntimeSession, error)
	SetVisible(context.Context, RuntimeSetVisibleInput) (ProviderRuntimeSession, error)
	Sessions(workspaceID string) []ProviderRuntimeSession
	Start(context.Context, RuntimeStartInput) (RuntimeStartResult, error)
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

type AgentComposerDefaultsReader interface {
	GetAgentComposerDefaultsForTarget(context.Context, string) (preferencesbiz.AgentComposerDefaults, error)
}

type DesktopPreferencesReader interface {
	Get(context.Context) (preferencesbiz.DesktopPreferences, error)
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

// ExtensionPermissionModeIDPolicy defines the identifier contract exposed by
// Composer Options for an extension permission mode. Runtime IDs are exact
// provider-owned values. Semantic IDs are Tutti's closed permission vocabulary
// and are only valid when the extension's launch contract explicitly consumes
// that vocabulary.
type ExtensionPermissionModeIDPolicy string

const (
	ExtensionPermissionModeIDPolicyRuntime  ExtensionPermissionModeIDPolicy = "runtime-id"
	ExtensionPermissionModeIDPolicySemantic ExtensionPermissionModeIDPolicy = "semantic-id"
)

type ExtensionComposerProfile struct {
	Capabilities                     []string
	ModelConfigOptionID              string
	PermissionConfigOptionID         string
	DefaultPermissionModeID          string
	PermissionModeIDPolicy           ExtensionPermissionModeIDPolicy
	PermissionModes                  []ExtensionComposerPermissionMode
	ReasoningConfigOptionID          string
	Skills                           *ExtensionComposerSkillProfile
	RuntimePrep                      *runtimeprep.ExtensionRuntimePrep
	SlashCommands                    []ExtensionComposerSlashCommand
	SlashCommandCatalogAuthoritative bool
}

type ExtensionComposerPermissionMode struct {
	RuntimeID string
	Semantic  PermissionModeSemantic
}

type ExtensionComposerSkillProfile struct {
	Invocation               string
	TriggerPrefix            string
	RuntimeCommandProjection string
	Roots                    []ExtensionComposerSkillRoot
}

type ExtensionComposerSkillRoot struct {
	Scope string
	Path  string
}

type ExtensionComposerSlashCommand struct {
	Name   string
	Effect string
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
	RailSectionKind      string
	RailProjectPath      string
	RailSectionKey       string
	Visible              bool
	Resumable            bool
	Settings             *ComposerSettings
	Capabilities         *canonical.CapabilitySnapshot
	PermissionConfig     PermissionConfig
	Title                *string
	MessageVersion       uint64
	PinnedAtUnixMS       int64
	CreatedAt            time.Time
	UpdatedAt            *time.Time
	EndedAt              *time.Time
	Metadata             agentactivitybiz.SessionMetadata
	Isolation            *SessionIsolation
	Warnings             []SessionWarning
	// Protocol v2 turn state (agent-gui refactor plan): the session keeps an
	// activeTurnId reference; phase/outcome/error live on the turn entity.
	ActiveTurnID           string
	ActiveTurn             *agentactivitybiz.Turn
	LatestTurn             *agentactivitybiz.Turn
	LatestTurnInteractions []agentactivitybiz.Interaction
	PendingInteractions    []agentactivitybiz.Interaction
	GoalSyncState          *SessionGoalSyncState
	TuttiModeActivation    *tuttimodeactivationbiz.Activation
	LifecycleCapabilities  SessionLifecycleCapabilities
	ForkedFrom             *SessionForkLineage
}

// SessionGoalSyncState is the narrow durable Goal-operation evidence exposed
// with a Session read. Goal lifecycle and recovery remain Host-owned.
type SessionGoalSyncState struct {
	Revision           int64
	SyncStatus         string
	PendingOperationID string
	ExecutionPending   bool
}

// SessionForkLineage is the durable provenance of a user-initiated root
// Session fork. It is distinct from provider-native child-session ownership.
type SessionForkLineage struct {
	SourceAgentSessionID string
	SourceTurnID         string
	TargetTurnID         string
	OperationID          string
	ForkedAtUnixMS       int64
}

// SessionLifecycleCapabilities contains exact-session lifecycle operations.
// These values are projected from canonical state and the attached runtime;
// they are deliberately separate from provider/composer capabilities.
type SessionLifecycleCapabilities struct {
	Fork            bool
	ForkThroughTurn bool
}

type SessionIsolation struct {
	WorktreeID   string `json:"worktreeId,omitempty"`
	Mode         string `json:"mode"`
	WorktreePath string `json:"worktreePath"`
	Branch       string `json:"branch"`
	BaseCommit   string `json:"baseCommit"`
}

type SessionWarning struct {
	Code    string
	Message string
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
	SessionIDs                 []string
	RequiredRootRailSectionKey string
	ExcludePinnedRoots         bool
}

type DeleteSessionResult struct {
	Removed       bool
	CleanupFailed bool
}

type DeleteSessionsBatchResult struct {
	RemovedMessages         int
	RemovedSessions         int
	RemovedSessionIDs       []string
	CleanupFailedSessionIDs []string
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
	RailSectionKind        string
	RailProjectPath        string
	RailSectionKey         string
	Settings               ComposerSettings
	Capabilities           *canonical.CapabilitySnapshot
	Metadata               agentactivitybiz.SessionMetadata
	InternalRuntimeContext map[string]any
	Title                  string
	MessageVersion         uint64
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
	Semantics         *agentactivitybiz.MessageSemantics
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

type RecoverableDeletedSessionResourceReader interface {
	ListRecoverableDeletedSessionResources(context.Context) ([]agentactivitybiz.DeletedSessionResource, error)
}

// GlobalAgentSessionIdentityReader checks the physical-resource identity,
// which is currently agent-session scoped rather than Workspace scoped. It is
// a tuttid product adapter contract and is intentionally not part of Host.
type GlobalAgentSessionIdentityReader interface {
	AgentSessionIDExists(context.Context, string) (bool, error)
	OtherWorkspaceLiveAgentSessionIDExists(context.Context, string, string) (bool, error)
}

type PersistedSessionListPage struct {
	Sessions   []PersistedSession
	HasMore    bool
	NextCursor string
}

type SessionPageReader interface {
	ListSessionsPage(context.Context, agentactivitybiz.ListSessionsPageInput) (PersistedSessionListPage, bool, error)
}

// SessionInitializer synchronously persists the canonical session shell that
// every successful Create response must expose. In particular, it assigns the
// immutable railSectionKey before the response leaves the daemon.
type SessionInitializer interface {
	InitializeRuntimeSession(context.Context, ProviderRuntimeSession, *agenthost.RailPlacement) (PersistedSession, error)
}

// sessionInitializerWithRailAuthority is an optional adapter capability for
// callers whose explicit rail placement comes from an external canonical
// authority. The legacy initializer remains valid for ordinary service paths;
// Host adapters must use this capability when they carry the authoritative
// placement bit across the service boundary.
type sessionInitializerWithRailAuthority interface {
	InitializeRuntimeSessionWithRailAuthority(context.Context, ProviderRuntimeSession, *agenthost.RailPlacement, bool) (PersistedSession, error)
}

type ChildSessionReader interface {
	ListChildSessions(context.Context, string, string) ([]PersistedSession, error)
}

type SessionDetail struct {
	Session       Session
	ChildSessions []Session
	Turns         []agentactivitybiz.Turn
	EditRetry     agenthost.EditRetryAvailability
}

type SessionSectionsReader interface {
	ListSessionSections(context.Context, agentactivitybiz.ListSessionSectionsInput) (agentactivitybiz.SessionSectionsPage, bool, error)
}

type SessionSectionReader interface {
	ListSessionSection(context.Context, agentactivitybiz.ListSessionSectionInput) (agentactivitybiz.SessionSectionPage, bool, error)
}

type SessionSectionDeletionCandidateReader interface {
	ListSessionSectionDeletionCandidates(context.Context, agentactivitybiz.ListSessionSectionDeletionCandidatesInput) (agentactivitybiz.SessionSectionDeletionCandidates, bool)
}

type SessionBatchDeleter interface {
	PlanClearSessions(context.Context, string) (agentactivitybiz.DeleteSessionsPlan, error)
	PlanDeleteSessions(context.Context, agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsPlan, error)
	// DeleteSessionsBatch is the canonical store mutation delegated by Host
	// after product deletion admission and runtime closure.
	DeleteSessionsBatch(context.Context, agentactivitybiz.DeleteSessionsBatchInput) (agentactivitybiz.DeleteSessionsBatchResult, error)
}

type UserProjectReader interface {
	List(context.Context) ([]userprojectbiz.Project, error)
}

type ClearSessionsResult struct {
	RemovedMessages         int
	RemovedSessions         int
	RemovedSessionIDs       []string
	CleanupFailedSessionIDs []string
}

type SessionClearer interface {
	// ClearSessions is a persistence-only fallback for isolated stores.
	ClearSessions(context.Context, string) (ClearSessionsResult, error)
}

type AgentSessionResourceReleaser interface {
	ReleaseAgent(context.Context, string) error
}

type SessionDeleter interface {
	// DeleteSession is a persistence-only fallback for isolated stores.
	DeleteSession(context.Context, string, string) (bool, error)
}

type SessionPinUpdater interface {
	UpdateSessionPinned(context.Context, string, string, bool) (PersistedSession, bool, error)
}

type SessionSettingsUpdater interface {
	UpdateSessionSettings(context.Context, string, string, ComposerSettings) (PersistedSession, bool, error)
}

type SessionTitleUpdater interface {
	UpdateSessionTitle(context.Context, string, string, string) (PersistedSession, bool, error)
}

// ProviderRuntimeSession is an adapter/controller-private snapshot. Its
// status, lifecycle and runtime context are provider observations only; they
// must never be exposed as, or used to overwrite, the durable Session/Turn/
// Interaction entities.
type ProviderRuntimeSession = agenthost.ProviderRuntimeSession
type RuntimeStartInput = agenthost.RuntimeStartInput
type RuntimeStartResult = agenthost.RuntimeStartResult
type RuntimeSessionInitializationPublishInput = agenthost.RuntimeSessionInitializationPublishInput
type RuntimeResumeInput = agenthost.RuntimeResumeInput
type RuntimeExecInput = agenthost.RuntimeExecInput
type RuntimeExecResult = agenthost.RuntimeExecResult
type CompletedCommand = agenthost.CompletedCommand
type SubmitAvailability = agenthost.SubmitAvailability
type TurnLifecycle = agenthost.TurnLifecycle
type RuntimeCancelInput = agenthost.RuntimeCancelInput
type RuntimeCancelTarget = agenthost.RuntimeCancelTarget
type RuntimeCancelResult = agenthost.RuntimeCancelResult

type RuntimeGoalControlInput = agenthost.RuntimeGoalControlInput
type RuntimeGoalControlResult = agenthost.RuntimeGoalControlResult
type RuntimeGoalReconcileResult = agenthost.RuntimeGoalReconcileResult
type RuntimeGoalRecoveryPolicy = agenthost.RuntimeGoalRecoveryPolicy
type RuntimeGoalGenerationFenceInput = agenthost.RuntimeGoalGenerationFenceInput
type RuntimeGoalRecoveryPolicyResolver interface {
	GoalRecoveryPolicy(context.Context, RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error)
}

type RuntimeGoalReconciler interface {
	ReconcileGoal(context.Context, RuntimeGoalControlInput) (RuntimeGoalReconcileResult, error)
}

type RuntimeGoalGenerationFencer interface {
	FenceGoalGeneration(context.Context, RuntimeGoalGenerationFenceInput) error
}

type RuntimeCloseInput = agenthost.RuntimeCloseInput
type RuntimeSubmitInteractiveInput = agenthost.RuntimeSubmitInteractiveInput
type RuntimeSubmitInteractiveResult = agenthost.RuntimeSubmitInteractiveResult
type RuntimeInteractiveDisposition = agenthost.RuntimeInteractiveDisposition

type TuttiModeTurnSnapshot = agenthost.TuttiModeTurnSnapshot

const (
	RuntimeInteractiveDispositionPending     = agenthost.RuntimeInteractiveDispositionPending
	RuntimeInteractiveDispositionResolving   = agenthost.RuntimeInteractiveDispositionResolving
	RuntimeInteractiveDispositionAnswered    = agenthost.RuntimeInteractiveDispositionAnswered
	RuntimeInteractiveDispositionSuperseded  = agenthost.RuntimeInteractiveDispositionSuperseded
	RuntimeInteractiveDispositionInterrupted = agenthost.RuntimeInteractiveDispositionInterrupted
	RuntimeInteractiveDispositionUnknown     = agenthost.RuntimeInteractiveDispositionUnknown
)

type RuntimeUpdateSettingsInput = agenthost.RuntimeUpdateSettingsInput
type RuntimeSetVisibleInput = agenthost.RuntimeSetVisibleInput
type RuntimeSetTitleInput = agenthost.RuntimeSetTitleInput
type ComposerSettingsPatch = agenthost.ComposerSettingsPatch

type RuntimeSubmitProvenanceInput = agenthost.RuntimeSubmitProvenanceInput

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
	// CommandCapabilityProjection is an internal, session-scoped command
	// discovery policy. A non-empty AllowedIDs is an exact capability set. The
	// policy is persisted in the immutable runtime snapshot so a resumed
	// dedicated session cannot regain commands outside that set.
	CommandCapabilityProjection *runtimeprep.CommandCapabilityProjection
	InitialContent              []PromptContentBlock
	// InitialGoalControl is delegated to Host as a typed lifecycle command and
	// never becomes an initial Turn.
	InitialGoalControl   *agenthost.TypedGoalControl
	InitialDisplayPrompt string
	Metadata             map[string]any
	ClientSubmitID       string
	Title                *string
	Cwd                  *string
	PermissionModeID     *string
	// StrictPermissionMode rejects an explicit unsupported permission mode
	// instead of applying the provider default. It is used by unattended
	// automation so a typo cannot silently broaden authority.
	StrictPermissionMode  bool
	Model                 *string
	ModelPlanID           *string
	PlanMode              *bool
	BrowserUse            *bool
	ComputerUse           *bool
	CodexSaverMode        *bool
	CodexSaverModeAllowed bool
	ProviderTargetRef     map[string]any
	ReasoningEffort       *string
	// ReasoningIntensity is an Issue-owned 0-100 strength request. When an
	// explicit ReasoningEffort is absent, Create compiles it against the
	// selected model's ordered reasoning-effort catalog. It is daemon-only and
	// is not persisted as a per-session user setting.
	ReasoningIntensity     *int
	RuntimeContext         map[string]any
	Isolation              string
	Speed                  *string
	ConversationDetailMode string
	Visible                *bool
	RailPlacement          *agenthost.RailPlacement
	// RailPlacementAuthoritative carries an externally canonical project
	// placement through the legacy service adapter used by conformance tests.
	RailPlacementAuthoritative bool
	ExtraSkills                []SessionSkillBundle
	// ExternalRolloutSourcePath is the absolute path to the original provider
	// CLI rollout/transcript file this session was imported from, when known.
	// Populated from the persisted session's RuntimeContext when resuming an
	// imported conversation (see createSessionInputFromPersisted); empty for
	// brand-new sessions.
	ExternalRolloutSourcePath string
}

// CreateSessionResult preserves the exact lifecycle identity returned by Host
// for callers that need to correlate the initial submission. Create remains
// the compatibility surface for consumers that only need the Session.
type CreateSessionResult struct {
	Session           Session
	TurnID            string
	SessionStatus     agenthost.CreateSessionStatus
	InitialGoalStatus agenthost.CreateSessionInitialGoalStatus
}

type TuttiModeActivationIntent struct {
	State  string
	Source string
	// Effect and Speed are optional; nil uses the daemon default.
	Effect *int
	Speed  *int
}

type SessionSkillBundle struct {
	Name  string
	Files map[string]string
}

type SendInput = agenthost.SendInput
type CapabilityReference = agenthost.CapabilityReference

type SendInputResult struct {
	Session            Session
	Kind               string
	TurnID             string
	Turn               *agentactivitybiz.Turn
	TurnLifecycle      TurnLifecycle
	SubmitAvailability SubmitAvailability
	GoalControl        *GoalControlSessionResult
}

type PromptContentBlock = agenthost.PromptContentBlock
type PromptAttachment = agenthost.PromptAttachment
type SubmitPlanDecisionInput = agenthost.SubmitPlanDecisionInput

type InteractionAction struct {
	ID       string
	Label    string
	Semantic string
}

type RespondInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	RequestID      string
	Action         *string
	OptionID       *string
	Payload        map[string]any
	Semantic       string
}

type RespondResult struct {
	RequestID   string
	TurnID      string
	Disposition RuntimeInteractiveDisposition
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
	TurnID         string
	Messages       []SessionMessage
	FinalMessage   *WaitFinalMessage
	Interactions   []WaitInteraction
	LatestVersion  uint64
	HasMore        bool
	Reason         WaitReason
	TimedOut       bool
	EffectiveAfter uint64
}

type WaitFinalMessage struct {
	TurnID string
	Text   string
}

type WaitInteraction struct {
	RequestID      string
	TurnID         string
	Kind           string
	ToolName       string
	Actions        []InteractionAction
	InputSummary   string
	InputTruncated bool
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
