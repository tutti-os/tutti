package runtimeprep

import (
	"context"
)

type Preparer interface {
	Prepare(context.Context, PrepareInput) (PreparedRuntime, error)
	Cleanup(context.Context, CleanupInput) error
}

// SessionForkProviderStateBinder makes provider-native fork state available
// from the target session's isolated runtime namespace.
type SessionForkProviderStateBinder interface {
	SupportsSessionForkProviderStateBinding(provider string) bool
	BindSessionForkProviderState(context.Context, SessionForkProviderStateBindingInput) error
}

type SessionForkProviderStateBindingInput struct {
	WorkspaceID             string
	Provider                string
	SourceAgentSessionID    string
	TargetAgentSessionID    string
	SourceProviderSessionID string
	TargetProviderSessionID string
}

type SkillBundleRenderer interface {
	RenderSkillBundle(context.Context, PrepareInput) (SkillBundle, error)
}

type PrepareInput struct {
	WorkspaceID    string
	AgentSessionID string
	AgentTargetID  string
	Provider       string
	Cwd            string
	// ProviderStateHome is the provider-native stable state root used as the
	// source for session preparation. For Codex this is the process-default
	// CODEX_HOME. Empty preserves the host user's legacy native-Home behavior;
	// VM-backed hosts should always pass an explicit absolute path.
	ProviderStateHome string
	// SkipSkills keeps provider preparation limited to the runtime data needed
	// by a model-only probe. It must not be used when launching a live Agent
	// Session or when the caller needs the provider's Skill catalog.
	SkipSkills             bool
	CLICommand             string
	CodexSaverMode         bool
	Title                  string
	PermissionModeID       string
	PlanMode               bool
	BrowserUse             bool
	ComputerUse            bool
	ProviderTargetRef      map[string]any
	Model                  string
	ReasoningEffort        string
	ConversationDetailMode string
	// AgentInstructions and the accompanying capability lists come from the
	// immutable WorkspaceAgent revision selected for this session. They are
	// non-secret and may be materialized into provider instructions.
	AgentName                 string
	AgentDescription          string
	AgentInstructions         string
	AgentCapabilitiesExplicit bool
	AgentSkills               []string
	AgentTools                []string
	ExtraSkills               []ProviderSkillBundle
	// ConnectorRoutingHints is a non-secret snapshot of Connector routes that
	// are active when this provider runtime is prepared. Connector keys and
	// display names are host-owned; aliases are declared by connector releases.
	// SkillRoot points at the active release's verified, content-addressed Skill
	// tree and remains stable across Connector runtime restarts.
	ConnectorRoutingHints []ConnectorRoutingHint
	// SharedInvocation is true when this runtime is prepared for a shared
	// agent: the Owner provides the environment and the Caller operates it
	// through a grant. Local sessions leave this false.
	SharedInvocation bool
	// EnabledConnectors is the user-enabled connector set at prepare time.
	// Rendered into session policy as a deterministic unique list, or "none".
	EnabledConnectors []string
	// MCPServers are daemon-issued, session-scoped native MCP bindings. They
	// are typed runtime configuration and must never be rendered into prompts.
	MCPServers []MCPServerBinding
	// Connector is the complete, session-bound Connector projection. The
	// preparer expands it into provider-native MCP, PATH, and Skill inputs.
	Connector *ConnectorAgentContext
	// ExtensionSkillRoots carries the skill root paths declared by an agent
	// extension's composer profile (Skills.Roots[].Path). When non-empty,
	// native tutti skills materialize into these roots instead of the
	// hard-coded providerSkillRoot, so acp: extension agents (hermes and
	// future ones) load tutti-handoff/tutti-cli. Paths are safe relative
	// paths validated by the extension profile; the selected runtime preparer
	// chooses whether they are resolved against Cwd or mirrored into the
	// session RuntimeRoot for provider isolation.
	ExtensionSkillRoots []string
	// ExtensionRuntimePrep carries a signed agent-extension runtime overlay.
	// It is provider-neutral: package profiles describe any required per-run
	// home, user-home file copies, and config merges instead of Tutti core
	// branching on a provider ID.
	ExtensionRuntimePrep *ExtensionRuntimePrep
	Metadata             map[string]any
	// CommandCapabilityProjection narrows the command guide for a dedicated
	// internal session. A non-empty AllowedIDs is an exact public/integration
	// set; otherwise public commands remain visible unless explicitly excluded.
	// Only the named integration commands are promoted into that session's
	// agent-facing snapshot.
	CommandCapabilityProjection *CommandCapabilityProjection
	// ModelEndpoint routes the session through a managed model access plan
	// endpoint when the agent target is bound to one. Nil keeps the
	// provider's native credential source. Credentials must never reach
	// logs, manifests, or generated instructions.
	ModelEndpoint       *ModelEndpointConfig
	resolved            *resolvedCapabilities
	hostFacts           HostFacts
	commandCapabilities *CommandResolver
	// ExternalRolloutSourcePath is the absolute path to the original provider
	// CLI rollout/transcript file this session was imported from (Codex CLI's
	// own on-disk conversation transcript under the provider's stable
	// `sessions/...` tree), when known. It lets a provider preparer expose
	// that one specific file into the sandboxed provider home so a native
	// `thread/resume` can find it, without exposing any other unrelated
	// conversation. Empty for non-imported sessions or when the source path
	// wasn't captured at import time.
	ExternalRolloutSourcePath string
}

type ConnectorRoutingHint struct {
	ConnectorKey string
	DisplayName  string
	Aliases      []string
	SkillRoot    string
}

type PreparedRuntime struct {
	Cwd        string
	Env        []string
	MCPServers []MCPServerBinding
}

type MCPServerBinding struct {
	Name    string
	Type    string
	URL     string
	Headers map[string]string
}

type ConnectorAgentContext struct {
	MCPServers      []MCPServerBinding
	RoutingHints    []ConnectorRoutingHint
	CLIBinDir       string
	SkillRoots      []string
	RuntimeRevision uint64
}

type ExtensionRuntimePrep struct {
	InstructionsFile string                `json:"instructionsFile,omitempty"`
	Home             *ExtensionRuntimeHome `json:"home,omitempty"`
}

type ExtensionRuntimeHome struct {
	EnvVar             string   `json:"envVar"`
	DirName            string   `json:"dirName"`
	SourceEnvVar       string   `json:"sourceEnvVar,omitempty"`
	SourceDefaultRel   string   `json:"sourceDefaultRel,omitempty"`
	CopyFiles          []string `json:"copyFiles,omitempty"`
	ConfigFile         string   `json:"configFile,omitempty"`
	ConfigFormat       string   `json:"configFormat,omitempty"`
	ExternalDirsKey    []string `json:"externalDirsKey,omitempty"`
	UserHomeSkillDir   string   `json:"userHomeSkillDir,omitempty"`
	IncludeSkillRoots  bool     `json:"includeSkillRoots,omitempty"`
	IncludeUserHomeDir bool     `json:"includeUserHomeDir,omitempty"`
}

type SkillBundle struct {
	SchemaVersion           int                          `json:"schemaVersion"`
	AgentTargetID           string                       `json:"agentTargetId"`
	Provider                string                       `json:"provider"`
	AgentSessionID          string                       `json:"agentSessionId"`
	CLICommand              string                       `json:"cliCommand"`
	RecommendedSystemPrompt *RecommendedSystemPrompt     `json:"recommendedSystemPrompt,omitempty"`
	Skills                  []SkillMaterializationRecord `json:"skills"`
}

type RecommendedSystemPrompt struct {
	Format  string `json:"format"`
	Content string `json:"content"`
}

type SkillMaterializationRecord struct {
	Content          string                     `json:"content,omitempty"`
	Files            []SkillMaterializationFile `json:"files,omitempty"`
	SkillID          string                     `json:"skillId"`
	Slug             string                     `json:"slug"`
	DeliveryMode     string                     `json:"deliveryMode"`
	MaterializedPath string                     `json:"materializedPath,omitempty"`
}

type SkillMaterializationFile struct {
	Content string `json:"content"`
	Path    string `json:"path"`
}

type CleanupInput struct {
	WorkspaceID    string
	AgentSessionID string
	Provider       string
	// PreserveRuntimeRoot releases live provider preparation resources while
	// keeping the session-scoped sidecar directory available for a later
	// restore. In particular, Codex keeps its resumable rollout below this
	// directory. Permanent cleanup leaves this false.
	PreserveRuntimeRoot bool
}

type RuntimeStore interface {
	RuntimeRoot(workspaceID string, agentSessionID string) (string, error)
	EnsureRuntimeRoot(runtimeRoot string) error
	WriteManagedBlock(path string, content string) (ManagedBlockWriteResult, error)
	SaveManifest(runtimeRoot string, manifest *Manifest) error
	CleanupRuntime(input StoreCleanupInput) error
}

type ProviderPreparer interface {
	Provider() string
	Prepare(context.Context, ProviderPrepareInput) (ProviderPrepareResult, error)
}

type ProviderPrepareInput struct {
	PrepareInput
	RuntimeRoot string
	Manifest    *Manifest
	Store       RuntimeStore
}

type ProviderPrepareResult struct {
	Cwd     string
	Env     []string
	Cleanup func(context.Context) error
}
