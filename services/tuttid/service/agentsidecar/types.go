package agentsidecar

import (
	"context"

	agentsidecarbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentsidecar"
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
	CommandGuide           string
	Title                  string
	PermissionModeID       string
	PlanMode               bool
	BrowserUse             bool
	ComputerUse            bool
	ProviderTargetRef      map[string]any
	Model                  string
	ReasoningEffort        string
	ConversationDetailMode string
	ExtraSkills            []ProviderSkillBundle
	Metadata               map[string]any
}

type PreparedRuntime struct {
	Cwd string
	Env []string
}

type ProviderSkillBundle struct {
	Name  string
	Files map[string]string
}

type SkillBundle struct {
	SchemaVersion           int                          `json:"schemaVersion"`
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
	WriteManagedBlock(path string, content string) (agentsidecarbiz.ManagedBlockWriteResult, error)
	SaveManifest(runtimeRoot string, manifest *agentsidecarbiz.Manifest) error
	CleanupRuntime(input agentsidecarbiz.CleanupInput) error
}

type ProviderPreparer interface {
	Provider() string
	Prepare(context.Context, ProviderPrepareInput) (ProviderPrepareResult, error)
}

type ProviderPrepareInput struct {
	PrepareInput
	RuntimeRoot string
	Manifest    *agentsidecarbiz.Manifest
	Store       RuntimeStore
}

type ProviderPrepareResult struct {
	Cwd string
	Env []string
}
