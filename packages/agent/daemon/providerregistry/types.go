package providerregistry

// RuntimeKind identifies the adapter family used to execute a provider. The
// runtime package maps each kind to an adapter constructor; provider identity
// must not be used as the constructor switch.
type RuntimeKind string

const (
	RuntimeKindCodexAppServer RuntimeKind = "codex_app_server"
	RuntimeKindClaudeSDK      RuntimeKind = "claude_sdk"
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
	InstallerKindOfficialScript InstallerKind = "official_script"
)

type StatusKind string

const (
	StatusKindCodexCLI  StatusKind = "codex_cli"
	StatusKindClaudeCLI StatusKind = "claude_cli"
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
}

type InstallerDescriptor struct {
	Kind            InstallerKind
	DisplayCommand  string
	PackageName     string
	BinaryName      string
	IncludeOptional bool
	ScriptURL       string
	ScriptShell     string
}

type StatusDescriptor struct {
	Kind                            StatusKind
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
	AuthWatch                       AuthWatchDescriptor
}

// AuthWatchDescriptor identifies files whose changes can invalidate
// provider-owned catalog data. RootEnvVar supports provider-specific home
// overrides without teaching consumers the provider's identity.
type AuthWatchDescriptor struct {
	RootEnvVar      string
	DefaultRoot     string
	Paths           []string
	HomePaths       []string
	FingerprintKind AuthWatchFingerprintKind
}

type AuthWatchFingerprintKind string

const (
	AuthWatchFingerprintNone        AuthWatchFingerprintKind = ""
	AuthWatchFingerprintClaudeState AuthWatchFingerprintKind = "claude_state"
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

type SkillKind string

const (
	SkillKindCodex      SkillKind = "codex"
	SkillKindClaudeCode SkillKind = "claude-code"
)

type SkillInvocation string

const (
	SkillInvocationPromptItem  SkillInvocation = "promptItem"
	SkillInvocationTextTrigger SkillInvocation = "textTrigger"
)

type SkillDescriptor struct {
	Kind       SkillKind
	Invocation SkillInvocation
}

type ModelCatalogKind string

const (
	ModelCatalogKindCodexCLI ModelCatalogKind = "codex-cli"
)

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

const LiveModelDiscoveryKindClaudeSDK LiveModelDiscoveryKind = "claude_sdk"

type LiveModelDiscoveryDescriptor struct {
	Kind        LiveModelDiscoveryKind
	HiddenProbe bool
}

type ComposerBehaviorDescriptor struct {
	ModelOptionsAuthoritative           bool
	RefreshModelOptionsAfterSettings    bool
	PrewarmDraftSession                 bool
	PlanModeExclusiveWithPermissionMode bool
}

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

type ComposerProfileDescriptor struct {
	ModelSelection          bool
	ModelCatalog            ModelCatalogKind
	ReasoningEffort         bool
	ReasoningEffortValues   []string
	DefaultReasoningEffort  string
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
	Behavior                ComposerBehaviorDescriptor
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
	TurnLifecycleProjectionLegacy   TurnLifecycleProjectionPolicy = "legacy"
	TurnLifecycleProjectionExplicit TurnLifecycleProjectionPolicy = "explicit"
)

type EventsDescriptor struct {
	Enabled                 bool
	Aliases                 []string
	TurnLifecycleProjection TurnLifecycleProjectionPolicy
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
}
