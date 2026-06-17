package agentsidecar

import (
	"context"

	agentsidecarbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentsidecar"
)

type Preparer interface {
	Prepare(context.Context, PrepareInput) (PreparedRuntime, error)
	Cleanup(context.Context, CleanupInput) error
}

type PrepareInput struct {
	WorkspaceID      string
	AgentSessionID   string
	Provider         string
	Cwd              string
	CLICommand       string
	CommandGuide     string
	Title            string
	PermissionModeID string
	PlanMode         bool
	BrowserUse       bool
	Model            string
	ReasoningEffort  string
	ExtraSkills      []ProviderSkillBundle
}

type PreparedRuntime struct {
	Cwd string
	Env []string
}

type ProviderSkillBundle struct {
	Name  string
	Files map[string]string
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
