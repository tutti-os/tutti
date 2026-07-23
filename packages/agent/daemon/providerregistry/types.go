package providerregistry

import (
	"github.com/tutti-os/tutti/packages/agent/daemon/managednpm"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

// RuntimeKind identifies the adapter family used to execute a provider. The
// runtime package maps each kind to an adapter constructor; provider identity
// must not be used as the constructor switch.
type RuntimeKind string

const (
	RuntimeKindCodexAppServer RuntimeKind = "codex_app_server"
	RuntimeKindStandardACP    RuntimeKind = "standard_acp"
	RuntimeKindClaudeSDK      RuntimeKind = "claude_sdk"
)

type StandardACPAdapterStrategy string

const (
	StandardACPAdapterStrategyGeneric  StandardACPAdapterStrategy = "generic"
	StandardACPAdapterStrategyCursor   StandardACPAdapterStrategy = "cursor"
	StandardACPAdapterStrategyNexight  StandardACPAdapterStrategy = "nexight"
	StandardACPAdapterStrategyOpenClaw StandardACPAdapterStrategy = "openclaw"
	StandardACPAdapterStrategyOpenCode StandardACPAdapterStrategy = "opencode"
)

// EndpointConfigKind identifies an optional provider-owned config source for
// endpoint discovery. Runtime consumers switch on this protocol/config shape,
// never on provider identity.
type EndpointConfigKind string

const (
	EndpointConfigKindCodexCLI       EndpointConfigKind = "codex_cli"
	EndpointConfigKindClaudeSettings EndpointConfigKind = "claude_settings"
)

// ModelPlanProtocol identifies the external model API protocol that a runtime
// can consume through Tutti's model-plan endpoint injection.
type ModelPlanProtocol string

const (
	ModelPlanProtocolAnthropic ModelPlanProtocol = "anthropic"
	ModelPlanProtocolOpenAI    ModelPlanProtocol = "openai"
)

// ModelPlanModelAddressing identifies how a runtime addresses a bound plan's
// models in composer and settings values. Consumers switch on this strategy,
// never on provider identity.
type ModelPlanModelAddressing string

const (
	// ModelPlanModelAddressingProviderPrefixed namespaces plan model ids as
	// "<injected-provider>/<model>" — the addressing OpenCode resolves against
	// the session-scoped provider config injected by runtimeprep. The empty
	// value means the runtime consumes raw plan model ids.
	ModelPlanModelAddressingProviderPrefixed ModelPlanModelAddressing = "provider_prefixed"
)

type RuntimeEndpointDescriptor struct {
	BaseURLEnvVars    []string
	ConfigKind        EndpointConfigKind
	ModelPlanProtocol ModelPlanProtocol
	// ModelPlanModelAddressing declares the composer/settings addressing for
	// bound plan models; empty means raw plan model ids.
	ModelPlanModelAddressing ModelPlanModelAddressing
	// NativeSubscription marks the one local runtime that can validate an
	// official subscription for this protocol without API credentials.
	NativeSubscription bool
}

// InstallerKind is a transport-neutral installer identifier. tuttid converts
// it to the concrete installer service contract at its composition boundary.
type InstallerKind string

const (
	InstallerKindCodexCLILatest InstallerKind = "codex_cli_latest"
	InstallerKindManagedNPM     InstallerKind = "managed_npm"
	InstallerKindOfficialScript InstallerKind = "official_script"
	InstallerKindShellCommand   InstallerKind = "shell_command"
)

type StatusKind string

const (
	StatusKindCodexCLI    StatusKind = "codex_cli"
	StatusKindOpenCodeCLI StatusKind = "opencode_cli"
	StatusKindClaudeCLI   StatusKind = "claude_cli"
	StatusKindGenericCLI  StatusKind = "generic_cli"
)

type StatusActionKind string

const StatusActionKindDaemon StatusActionKind = "daemon_action"

// AuthOutputParserKind identifies the CLI output grammar used by an auth
// status command. Consumers dispatch on this strategy, never provider identity.
type AuthOutputParserKind string

const (
	AuthOutputParserKindCodex    AuthOutputParserKind = "codex"
	AuthOutputParserKindClaude   AuthOutputParserKind = "claude"
	AuthOutputParserKindOpenCode AuthOutputParserKind = "opencode"
	AuthOutputParserKindCursor   AuthOutputParserKind = "cursor"
)

type AuthMarkerParserKind string

const (
	AuthMarkerParserKindFileExists AuthMarkerParserKind = "file_exists"
	AuthMarkerParserKindClaude     AuthMarkerParserKind = "claude"
	AuthMarkerParserKindTuttiToken AuthMarkerParserKind = "tutti_token"
)

type AuthCommandRunnerKind string

const (
	AuthCommandRunnerKindGeneric    AuthCommandRunnerKind = "generic"
	AuthCommandRunnerKindClaudeGate AuthCommandRunnerKind = "claude_gate"
	AuthCommandRunnerKindCursor     AuthCommandRunnerKind = "cursor"
)

type StaticSpecResolverKind string

const (
	StaticSpecResolverKindGeneric     StaticSpecResolverKind = "generic"
	StaticSpecResolverKindManagedNode StaticSpecResolverKind = "managed_node"
	StaticSpecResolverKindCursor      StaticSpecResolverKind = "cursor"
)

// Deprecated: use canonical.ProviderIdentity.
type IdentityDescriptor = canonical.ProviderIdentity

type RuntimeDescriptor struct {
	Kind                RuntimeKind
	Name                string
	Command             []string
	ClientInfoName      string
	AuthRequiredMessage string
	Endpoint            RuntimeEndpointDescriptor
	StandardACP         StandardACPRuntimeDescriptor
}

type RuntimePermissionModeDescriptor struct {
	InputID   string
	RuntimeID string
}

type RuntimeSettingField string

const RuntimeSettingFieldModel RuntimeSettingField = "model"

type RuntimeSettingsJSONFieldDescriptor struct {
	Setting RuntimeSettingField
	JSONKey string
}

type RuntimeSettingsEnvironmentDescriptor struct {
	Variable   string
	JSONFields []RuntimeSettingsJSONFieldDescriptor
}

type StandardACPRuntimeDescriptor struct {
	AdapterStrategy                StandardACPAdapterStrategy
	PermissionModes                []RuntimePermissionModeDescriptor
	DefaultPermissionModeRuntimeID string
	SettingsEnvironment            RuntimeSettingsEnvironmentDescriptor
	PlanModeRuntimeID              string
	PlanModeDisabledRuntimeID      string
	ProjectCurrentMode             bool
	StartupDiagnostics             bool
	DeriveImageInputFromPrompt     bool
	DeriveCapabilitiesFromCommands []string
	// AutoApprovePermissionModeInputIDs lists the permission-tier input ids
	// whose incoming session/request_permission calls the client resolves as
	// approved without prompting. This is the data-driven form of the
	// per-provider auto-approval policy so the shared (generic-strategy) adapter
	// factory installs it — provider-specific constructors are not on the
	// default controller's construction path. Every id must be declared in
	// PermissionModes.
	AutoApprovePermissionModeInputIDs []string
}

type InstallerDescriptor struct {
	Kind                 InstallerKind
	DisplayCommand       string
	PackageName          string
	BinaryName           string
	RecommendedVersion   string
	IncludeOptional      bool
	ScriptURL            string
	ScriptShell          string
	ShellCommand         string
	FailureReasonMarkers map[string][]string
}

func (d ProviderDescriptor) ManagedNPMDescriptor() (managednpm.Descriptor, bool) {
	if d.Status.Install.Kind != InstallerKindManagedNPM {
		return managednpm.Descriptor{}, false
	}
	return managednpm.Descriptor{
		PackageName:        d.Status.Install.PackageName,
		BinaryName:         d.Status.Install.BinaryName,
		MinimumVersion:     d.Status.MinVersion,
		RecommendedVersion: d.Status.Install.RecommendedVersion,
		IncludeOptional:    d.Status.Install.IncludeOptional,
	}, true
}

// UpdateCapability declares whether tuttid may safely discover and apply CLI
// updates for a provider. Unsupported is explicit: callers must not infer an
// update path from the install command or provider identity.
type UpdateCapability string

const (
	UpdateCapabilitySupported   UpdateCapability = "supported"
	UpdateCapabilityUnsupported UpdateCapability = "unsupported"
)

type UpdateSource string

const UpdateSourceNPM UpdateSource = "npm"

type UpdateStrategy string

const UpdateStrategyManagedNPM UpdateStrategy = "managed_npm"

const (
	UpdateUnsupportedReasonOfficialScript  = "official_script_update_unsupported"
	UpdateUnsupportedReasonUnmanagedSource = "unmanaged_install_source"
	UpdateUnsupportedReasonProvider        = "provider_update_unsupported"
)

// UpdateDescriptor is deliberately separate from InstallerDescriptor. Install
// repairs missing or below-minimum runtimes; update discovers and applies a
// newer release only after an explicit update action.
type UpdateDescriptor struct {
	Capability        UpdateCapability
	Source            UpdateSource
	Strategy          UpdateStrategy
	PackageName       string
	BinaryName        string
	IncludeOptional   bool
	UnsupportedReason string
}

type StatusDescriptor struct {
	Kind                            StatusKind
	AuthOutputParserKind            AuthOutputParserKind
	AuthMarkerParserKind            AuthMarkerParserKind
	AuthCommandRunnerKind           AuthCommandRunnerKind
	StaticSpecResolverKind          StaticSpecResolverKind
	MinVersion                      string
	BinaryNames                     []string
	AdapterBinaryNames              []string
	AuthStatusCommand               []string
	AuthStatusCommandTimeoutSeconds int
	AuthMarkerPaths                 []string
	APIEndpoints                    []string
	CustomConfigEnvVars             []string
	CredentialEnvVars               []string
	NPMRegistryPackage              string
	Install                         InstallerDescriptor
	Update                          UpdateDescriptor
	LoginArgs                       []string
	LoginActionKind                 StatusActionKind
	AuthWatch                       AuthWatchDescriptor
	SupportStatus                   string
	DisabledReasonCode              string
}

type ExternalImportParserKind string

const (
	ExternalImportParserKindCodexJSONL  ExternalImportParserKind = "codex_jsonl"
	ExternalImportParserKindClaudeJSONL ExternalImportParserKind = "claude_jsonl"
)

type ExternalImportUserTextCleanerKind string

const (
	ExternalImportUserTextCleanerKindCodex  ExternalImportUserTextCleanerKind = "codex"
	ExternalImportUserTextCleanerKindClaude ExternalImportUserTextCleanerKind = "claude"
)

type ExternalImportTitleCatalogKind string

const ExternalImportTitleCatalogKindCodexSQLite ExternalImportTitleCatalogKind = "codex_sqlite"

// ExternalImportDescriptor declares the local transcript layout and parsing
// strategies for a provider. Enabled=false is an explicit unsupported policy.
type ExternalImportDescriptor struct {
	Enabled                  bool
	RootEnvVar               string
	DefaultRoot              string
	ScanDirectories          []string
	SkipDirectoryPrefixes    []string
	ParserKind               ExternalImportParserKind
	UserTextCleanerKind      ExternalImportUserTextCleanerKind
	TitleCatalogKind         ExternalImportTitleCatalogKind
	NoProjectHomeRelativeDir string
}

type AuthWatchDescriptor struct {
	Sources            []AuthWatchSourceDescriptor
	ContentFingerprint AuthWatchContentFingerprintKind
}

type AuthWatchRootCandidateDescriptor struct {
	EnvVar string
	Suffix string
}

type AuthWatchSourceDescriptor struct {
	PathEnvVars    []string
	RootCandidates []AuthWatchRootCandidateDescriptor
	DefaultRoot    string
	Paths          []string
}

type AuthWatchContentFingerprintKind string

const (
	AuthWatchContentFingerprintFullFile    AuthWatchContentFingerprintKind = "full_file"
	AuthWatchContentFingerprintClaudeState AuthWatchContentFingerprintKind = "claude_state"
)

type PermissionModeDescriptor struct {
	ID       string
	Semantic string
}

type ComposerConfigOptionIDs struct {
	Model      string
	Reasoning  string
	Speed      string
	Permission string
}

// Canonical capability vocabulary shared by provider descriptors, daemon
// runtime projections, and the generated/checked GUI mirror.
const (
	CapabilityImageInput                     = canonical.CapabilityImageInput
	CapabilityModelImageInputRequired        = canonical.CapabilityModelImageInputRequired
	CapabilityModelSwitch                    = canonical.CapabilityModelSwitch
	CapabilityModelPlanBinding               = canonical.CapabilityModelPlanBinding
	CapabilitySkills                         = canonical.CapabilitySkills
	CapabilityCompact                        = canonical.CapabilityCompact
	CapabilityTokenUsage                     = canonical.CapabilityTokenUsage
	CapabilityRateLimits                     = canonical.CapabilityRateLimits
	CapabilityPlanMode                       = canonical.CapabilityPlanMode
	CapabilityInterrupt                      = canonical.CapabilityInterrupt
	CapabilityActiveTurnGuidance             = canonical.CapabilityActiveTurnGuidance
	CapabilityBrowserUse                     = canonical.CapabilityBrowserUse
	CapabilityComputerUse                    = canonical.CapabilityComputerUse
	CapabilityGoalPause                      = canonical.CapabilityGoalPause
	CapabilityPlanImplementation             = canonical.CapabilityPlanImplementation
	CapabilityPermissionModeChangeDuringTurn = canonical.CapabilityPermissionModeChangeDuringTurn
	CapabilityPermissionModeChangeDeferred   = canonical.CapabilityPermissionModeChangeDeferred
	CapabilityReview                         = canonical.CapabilityReview
	CapabilityResumeRunningTurn              = canonical.CapabilityResumeRunningTurn
)

type SkillKind string

const (
	SkillKindCodex      SkillKind = "codex"
	SkillKindClaudeCode SkillKind = "claude-code"
	SkillKindCursor     SkillKind = "cursor"
	SkillKindOpenCode   SkillKind = "opencode"
)

type SkillInvocation string

const (
	SkillInvocationPromptItem  SkillInvocation = "promptItem"
	SkillInvocationTextTrigger SkillInvocation = "textTrigger"
)

type SkillDescriptor struct {
	Kind            SkillKind
	Invocation      SkillInvocation
	ConfigDirSuffix string
}

type ModelCatalogKind string

const (
	ModelCatalogKindCodexCLI    ModelCatalogKind = "codex-cli"
	ModelCatalogKindOpenCodeCLI ModelCatalogKind = "opencode-cli"
	ModelCatalogKindTuttiCLI    ModelCatalogKind = "tutti-agent-cli"
)

type ReasoningEffortOptionsKind string

const (
	ReasoningEffortOptionsStatic             ReasoningEffortOptionsKind = "static"
	ReasoningEffortOptionsModelCatalog       ReasoningEffortOptionsKind = "model_catalog"
	ReasoningEffortOptionsStrictModelCatalog ReasoningEffortOptionsKind = "strict_model_catalog"
)

type ConfiguredModelOverrideKind string

const ConfiguredModelOverrideCodexCustomProvider ConfiguredModelOverrideKind = "codex_custom_provider"

// CapabilityCatalogKind identifies the protocol used to discover the
// provider's dynamic composer capabilities.
type CapabilityCatalogKind string

const (
	CapabilityCatalogKindCodexAppServer CapabilityCatalogKind = "codex_app_server"
)

type CapabilityCatalogDescriptor struct {
	Kind CapabilityCatalogKind
}

type LiveModelDiscoveryKind string

const (
	LiveModelDiscoveryKindClaudeSDK      LiveModelDiscoveryKind = "claude_sdk"
	LiveModelDiscoveryKindRuntimeSession LiveModelDiscoveryKind = "runtime_session"
)

type LiveModelDiscoveryDescriptor struct {
	Kind          LiveModelDiscoveryKind
	HiddenProbe   bool
	AccountScoped bool
}

type ComposerBehaviorDescriptor struct {
	CollapseModelOptionsToLatest        bool
	ModelOptionsAuthoritative           bool
	RefreshModelOptionsAfterSettings    bool
	PrewarmDraftSession                 bool
	PlanModeExclusiveWithPermissionMode bool
	PreserveLiveModelCache              bool
}

type ModelCapabilityRuleKind string

const ModelCapabilityRuleKindCursorComposerImage ModelCapabilityRuleKind = "cursor_composer_image"

type SlashCommandEffect string

const (
	SlashCommandEffectSubmitImmediate  SlashCommandEffect = "submitImmediate"
	SlashCommandEffectShowReviewPicker SlashCommandEffect = "showReviewPicker"
	SlashCommandEffectActivateGoalMode SlashCommandEffect = "activateGoalMode"
	SlashCommandEffectTogglePlanMode   SlashCommandEffect = "togglePlanMode"
	SlashCommandEffectShowStatus       SlashCommandEffect = "showStatus"
	SlashCommandEffectToggleSpeed      SlashCommandEffect = "toggleSpeed"
)

type SlashCommandEffectDescriptor struct {
	Command string
	Effect  SlashCommandEffect
}

type SlashCommandPolicyDescriptor struct {
	FallbackCommands            []string
	CommandEffects              []SlashCommandEffectDescriptor
	CommandCatalogAuthoritative bool
}

// Deprecated: use canonical.PlanDecisionStrategy.
type PlanDecisionStrategy = canonical.PlanDecisionStrategy

const (
	PlanDecisionStrategyNone            = canonical.PlanDecisionStrategyNone
	PlanDecisionStrategyImplementPrompt = canonical.PlanDecisionStrategyImplementPrompt
)

type ComposerProfileDescriptor struct {
	ModelSelection          bool
	ModelCatalog            ModelCatalogKind
	ReasoningEffort         bool
	ReasoningEffortValues   []string
	ReasoningEffortOptions  ReasoningEffortOptionsKind
	DefaultReasoningEffort  string
	ConfiguredModelOverride ConfiguredModelOverrideKind
	Speed                   bool
	SpeedValues             []string
	DefaultSpeed            string
	Capabilities            []string
	PermissionConfigurable  bool
	DefaultPermissionModeID string
	PermissionModes         []PermissionModeDescriptor
	ConfigOptionIDs         ComposerConfigOptionIDs
	Skills                  SkillDescriptor
	CapabilityCatalog       CapabilityCatalogDescriptor
	LiveModelDiscovery      LiveModelDiscoveryDescriptor
	SlashCommandPolicy      SlashCommandPolicyDescriptor
	PlanDecisionStrategy    PlanDecisionStrategy
	Behavior                ComposerBehaviorDescriptor
	ModelCapabilityRuleKind ModelCapabilityRuleKind
}

type TargetDescriptor struct {
	ID            string
	LaunchRefType string
	Enabled       bool
	SortOrder     int
}

const TargetLaunchRefTypeLocalCLI = "local_cli"

type TurnLifecycleProjectionPolicy string

const (
	TurnLifecycleProjectionExplicit TurnLifecycleProjectionPolicy = "explicit"
)

type EventsDescriptor struct {
	Enabled                 bool
	Aliases                 []string
	TurnLifecycleProjection TurnLifecycleProjectionPolicy
}

type SidecarMentionRoutingKind string

const (
	SidecarMentionRoutingClaudeNamespaced SidecarMentionRoutingKind = "claude_namespaced"
)

type SidecarExecutionEnvironmentKind string

const (
	SidecarExecutionEnvironmentCodexSandbox SidecarExecutionEnvironmentKind = "codex_sandbox"
	SidecarExecutionEnvironmentClaudeIPC    SidecarExecutionEnvironmentKind = "claude_ipc"
	SidecarExecutionEnvironmentLocalIPC     SidecarExecutionEnvironmentKind = "local_ipc"
)

type SidecarDescriptor struct {
	MentionRouting       SidecarMentionRoutingKind
	ExecutionEnvironment SidecarExecutionEnvironmentKind
	SkillRoot            string
}

type DesktopUsageProbeKind string

const (
	DesktopUsageProbeCodex      DesktopUsageProbeKind = "codex"
	DesktopUsageProbeClaudeCode DesktopUsageProbeKind = "claude_code"
)

type DesktopVisibilityGate string

const (
	DesktopVisibilityGateTuttiAgent DesktopVisibilityGate = "tutti_agent"
)

type DesktopRuntimeProbeFallback string

const (
	DesktopRuntimeProbeFallbackDirect DesktopRuntimeProbeFallback = "direct"
)

type DesktopIntegrationDescriptor struct {
	Managed                    bool
	ManagedOrder               int
	StatusProbePriority        int
	UsageProbeKind             DesktopUsageProbeKind
	VisibilityGate             DesktopVisibilityGate
	RuntimeProbeFallback       DesktopRuntimeProbeFallback
	InstallBootstrap           bool
	RefreshOnAccountChange     bool
	UnavailableDockOrderOffset int
	DeveloperLogs              bool
	DefaultProviderEligible    bool
	DefaultProviderPriority    int
}

// ProviderDescriptor is the single registration contract for a migrated
// provider. Each layer consumes its own section and must not re-declare the
// provider-specific values locally.
type ProviderDescriptor struct {
	Identity        IdentityDescriptor
	Runtime         RuntimeDescriptor
	Status          StatusDescriptor
	ComposerProfile ComposerProfileDescriptor
	Target          TargetDescriptor
	Events          EventsDescriptor
	Sidecar         SidecarDescriptor
	Desktop         DesktopIntegrationDescriptor
	ExternalImport  ExternalImportDescriptor
}
