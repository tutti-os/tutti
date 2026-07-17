package runtimeprep

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var ErrCwdNotDirectory = errors.New("agent runtime cwd is not a directory")

type DefaultPreparer struct {
	StateDir             string
	CLICommand           string
	CommandCatalog       CommandCatalog
	Store                RuntimeStore
	ComputerUseAvailable func() bool
	Profile              DeploymentProfile
	SkillSources         []SkillSource
	providers            map[string]ProviderPreparer
}

func NewDefaultPreparer(stateDir string) *DefaultPreparer {
	preparer := &DefaultPreparer{
		StateDir:  stateDir,
		Profile:   StandardProfile(),
		providers: make(map[string]ProviderPreparer),
	}
	preparer.RegisterProvider(CodexPreparer{})
	preparer.RegisterProvider(ClaudeCodePreparer{StateDir: stateDir})
	preparer.RegisterProvider(CursorPreparer{})
	preparer.RegisterProvider(OpenCodePreparer{})
	preparer.RegisterProvider(InstructionFilePreparer{ProviderID: "nexight", FileName: "AGENTS.md"})
	preparer.RegisterProvider(InstructionFilePreparer{ProviderID: "hermes", FileName: "AGENTS.md"})
	preparer.RegisterProvider(InstructionFilePreparer{ProviderID: "openclaw", FileName: "AGENTS.md"})
	return preparer
}

func (p *DefaultPreparer) RegisterProvider(provider ProviderPreparer) {
	if provider == nil {
		return
	}
	providerID := strings.TrimSpace(provider.Provider())
	if providerID == "" {
		return
	}
	if p.providers == nil {
		p.providers = make(map[string]ProviderPreparer)
	}
	p.providers[providerID] = provider
}

func (p *DefaultPreparer) Prepare(ctx context.Context, input PrepareInput) (PreparedRuntime, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	providerID := strings.TrimSpace(input.Provider)
	cwd := strings.TrimSpace(input.Cwd)
	if workspaceID == "" || agentSessionID == "" || providerID == "" {
		return PreparedRuntime{}, errors.New("agent runtime prepare requires workspace, session, and provider")
	}
	if cwd == "" {
		return PreparedRuntime{}, errors.New("agent runtime prepare requires cwd")
	}
	input.WorkspaceID = workspaceID
	input.AgentSessionID = agentSessionID
	input.Provider = providerID
	input.Cwd = cwd
	logRuntimePrepareTrace("runtime_prepare.entered", input, map[string]any{
		"provider": providerID,
		"cwd":      cwd,
	})
	if err := ensureCwdDirectory(cwd); err != nil {
		return PreparedRuntime{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.cwd_checked", input, nil)

	store := p.runtimeStore()
	runtimeRoot, err := store.RuntimeRoot(workspaceID, agentSessionID)
	if err != nil {
		return PreparedRuntime{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.runtime_root_resolved", input, nil)
	if err := store.EnsureRuntimeRoot(runtimeRoot); err != nil {
		return PreparedRuntime{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.runtime_root_ensured", input, nil)

	input = p.normalizeCapabilities(input)
	manifest := NewManifest(ManifestInput{
		AgentSessionID: agentSessionID,
		Provider:       providerID,
		Cwd:            cwd,
		RuntimeRoot:    runtimeRoot,
	})
	input.CLICommand = firstNonEmptyText(input.CLICommand, p.CLICommand, resolveCLICommand(p.StateDir))
	input.CommandGuide = commandGuideFromCatalog(ctx, p.CommandCatalog, workspaceID, input.CLICommand)
	resolved, err := resolveCapabilities(ctx, input, p.Profile, p.SkillSources)
	if err != nil {
		return PreparedRuntime{}, err
	}
	input.resolved = resolved
	logRuntimePrepareTrace("runtime_prepare.input_normalized", input, map[string]any{
		"cli_command":          input.CLICommand,
		"command_guide_length": len(input.CommandGuide),
	})

	result := ProviderPrepareResult{Cwd: cwd}
	if provider := p.provider(providerID); provider != nil {
		logRuntimePrepareTrace("runtime_prepare.provider_requested", input, map[string]any{
			"provider": providerID,
		})
		result, err = provider.Prepare(ctx, ProviderPrepareInput{
			PrepareInput: input,
			RuntimeRoot:  runtimeRoot,
			Manifest:     manifest,
			Store:        store,
		})
		if err != nil {
			return PreparedRuntime{}, err
		}
		logRuntimePrepareTrace("runtime_prepare.provider_resolved", input, map[string]any{
			"provider_env_count": len(result.Env),
			"cwd":                result.Cwd,
		})
	}
	if result.Cwd == "" {
		result.Cwd = cwd
	}
	result.Env = append(defaultRuntimeEnv(input, p.StateDir), result.Env...)
	logRuntimePrepareTrace("runtime_prepare.env_prepared", input, map[string]any{
		"env_count": len(result.Env),
	})
	if err := store.SaveManifest(runtimeRoot, manifest); err != nil {
		return PreparedRuntime{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.manifest_saved", input, nil)
	return PreparedRuntime(result), nil
}

func (p *DefaultPreparer) RenderSkillBundle(ctx context.Context, input PrepareInput) (SkillBundle, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	providerID := strings.TrimSpace(input.Provider)
	if workspaceID == "" || agentTargetID == "" || providerID == "" {
		return SkillBundle{}, errors.New("agent skill bundle render requires workspace, agent target, and provider")
	}

	input.WorkspaceID = workspaceID
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.AgentTargetID = agentTargetID
	input.Provider = providerID
	input.CLICommand = firstNonEmptyText(input.CLICommand, p.CLICommand, resolveCLICommand(p.StateDir))
	input = p.normalizeCapabilities(input)
	input.CommandGuide = commandGuideFromCatalog(ctx, p.CommandCatalog, workspaceID, input.CLICommand)
	resolved, err := resolveCapabilities(ctx, input, p.Profile, p.SkillSources)
	if err != nil {
		return SkillBundle{}, err
	}
	input.resolved = resolved
	return renderProviderSkillBundle(input), nil
}

func (p *DefaultPreparer) Cleanup(_ context.Context, input CleanupInput) error {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return errors.New("agent runtime cleanup requires workspace and session")
	}
	return p.runtimeStore().CleanupRuntime(StoreCleanupInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
	})
}

func ensureCwdDirectory(cwd string) error {
	info, err := os.Stat(cwd)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", ErrCwdNotDirectory, cwd)
		}
		return fmt.Errorf("stat agent runtime cwd: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: %s", ErrCwdNotDirectory, cwd)
	}
	return nil
}

func (p *DefaultPreparer) provider(providerID string) ProviderPreparer {
	if p == nil {
		return nil
	}
	return p.providers[strings.TrimSpace(providerID)]
}

func (p *DefaultPreparer) runtimeStore() RuntimeStore {
	if p.Store != nil {
		return p.Store
	}
	return LocalStore{StateDir: p.StateDir}
}

func (p *DefaultPreparer) normalizeCapabilities(input PrepareInput) PrepareInput {
	if input.ComputerUse && p != nil && p.ComputerUseAvailable != nil {
		input.ComputerUse = p.ComputerUseAvailable()
	}
	return input
}

func defaultRuntimeEnv(input PrepareInput, stateDir string) []string {
	env := []string{
		"TUTTI_WORKSPACE_ID=" + strings.TrimSpace(input.WorkspaceID),
		"TUTTI_AGENT_SESSION_ID=" + strings.TrimSpace(input.AgentSessionID),
		"TUTTI_AGENT_TARGET_ID=" + strings.TrimSpace(input.AgentTargetID),
		"TUTTI_AGENT_PROVIDER=" + strings.TrimSpace(input.Provider),
		"TUTTI_AGENT_CWD=" + strings.TrimSpace(input.Cwd),
	}
	if pathEnv := runtimePathEnv(stateDir); pathEnv != "" {
		env = append(env, pathEnv)
	}
	// Browser use is delivered as a default MCP server to every agent provider,
	// so it is advertised here in the shared runtime env rather than per-provider.
	if input.resolved != nil {
		env = append(env, input.resolved.EnvOverlay...)
	} else {
		env = append(env, browserUseEnv(input.BrowserUse)...)
		env = append(env, computerUseEnv(input.ComputerUse)...)
	}
	return env
}

func runtimePathEnv(stateDir string) string {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return ""
	}
	binDir := filepath.Join(stateDir, "bin")
	currentPath := os.Getenv("PATH")
	for _, entry := range filepath.SplitList(currentPath) {
		if filepath.Clean(entry) == filepath.Clean(binDir) {
			return "PATH=" + currentPath
		}
	}
	if currentPath == "" {
		return "PATH=" + binDir
	}
	return "PATH=" + binDir + string(os.PathListSeparator) + currentPath
}
