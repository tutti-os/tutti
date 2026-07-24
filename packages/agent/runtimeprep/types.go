package runtimeprep

import (
	"context"
)

type Preparer interface {
	Prepare(context.Context, PrepareInput) (PreparedRuntime, error)
	Cleanup(context.Context, CleanupInput) error
}

type SkillBundleRenderer interface {
	RenderSkillBundle(context.Context, PrepareInput) (SkillBundle, error)
}

type PrepareInput struct {
	WorkspaceID            string
	AgentSessionID         string
	AgentTargetID          string
	Provider               string
	Cwd                    string
	CLICommand             string
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
	Metadata                  map[string]any
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
	// own on-disk conversation transcript under the user's real
	// `~/.codex/sessions/...`), when known. It lets a provider preparer expose
	// that one specific file into the sandboxed provider home so a native
	// `thread/resume` can find it, without exposing any other unrelated
	// conversation. Empty for non-imported sessions or when the source path
	// wasn't captured at import time.
	ExternalRolloutSourcePath string
}

type PreparedRuntime struct {
	Cwd string
	Env []string
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
	Cwd string
	Env []string
}
