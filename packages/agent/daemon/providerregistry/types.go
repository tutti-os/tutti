package providerregistry

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

type RuntimeEndpointDescriptor struct {
	BaseURLEnvVars []string
	ConfigKind     EndpointConfigKind
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

type IdentityDescriptor struct {
	ID          string
	DisplayName string
	IconKey     string
	LocaleKey   string
	Aliases     []string
}

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
}

type InstallerDescriptor struct {
	Kind                 InstallerKind
	DisplayCommand       string
	PackageName          string
	BinaryName           string
	IncludeOptional      bool
	ScriptURL            string
	ScriptShell          string
	ShellCommand         string
	FailureReasonMarkers map[string][]string
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
	CapabilityImageInput                     = "imageInput"
	CapabilityModelImageInputRequired        = "modelImageInputRequired"
	CapabilitySkills                         = "skills"
	CapabilityCompact                        = "compact"
	CapabilityTokenUsage                     = "tokenUsage"
	CapabilityRateLimits                     = "rateLimits"
	CapabilityPlanMode                       = "planMode"
	CapabilityInterrupt                      = "interrupt"
	CapabilityActiveTurnGuidance             = "activeTurnGuidance"
	CapabilityBrowserUse                     = "browserUse"
	CapabilityComputerUse                    = "computerUse"
	CapabilityGoalPause                      = "goalPause"
	CapabilityPlanImplementation             = "planImplementation"
	CapabilityPermissionModeChangeDuringTurn = "permissionModeChangeDuringTurn"
	CapabilityPermissionModeChangeDeferred   = "permissionModeChangeDeferred"
	CapabilityReview                         = "review"
	CapabilityResumeRunningTurn              = "resumeRunningTurn"
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

type PlanDecisionStrategy string

const (
	PlanDecisionStrategyNone            PlanDecisionStrategy = ""
	PlanDecisionStrategyImplementPrompt PlanDecisionStrategy = "implement_prompt"
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
	DesktopVisibilityGateCursorPreview   DesktopVisibilityGate = "cursor_preview"
	DesktopVisibilityGateOpenCodePreview DesktopVisibilityGate = "opencode_preview"
	DesktopVisibilityGateTuttiAgent      DesktopVisibilityGate = "tutti_agent"
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
