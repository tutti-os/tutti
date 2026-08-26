package runtimeprep

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var ErrCwdNotDirectory = errors.New("agent runtime cwd is not a directory")

type DefaultPreparer struct {
	StateDir       string
	CLICommand     string
	CommandCatalog CommandCatalog
	Store          RuntimeStore
	// BrowserUseAvailable is an optional live readiness probe. A nil probe
	// preserves configuration-only behavior for embedders without a browser service.
	BrowserUseAvailable  func() bool
	ComputerUseAvailable func() bool
	// RTKExecutableResolver resolves the Tutti-owned RTK binary for an enabled
	// Session. Production hosts provide a bundled or managed-runtime resolver;
	// standalone embedders must provide the same exact-path contract.
	RTKExecutableResolver func(context.Context) (string, error)
	Profile               DeploymentProfile
	SkillSources          []SkillSource
	providers             map[string]ProviderPreparer
	cleanupMu             sync.Mutex
	providerCleanup       map[string]func(context.Context) error
}

func NewDefaultPreparer(stateDir string) *DefaultPreparer {
	preparer := &DefaultPreparer{
		StateDir:        stateDir,
		Profile:         StandardProfile(),
		providers:       make(map[string]ProviderPreparer),
		providerCleanup: make(map[string]func(context.Context) error),
	}
	preparer.RegisterProvider(CodexPreparer{})
	preparer.RegisterProvider(ClaudeCodePreparer{StateDir: stateDir})
	preparer.RegisterProvider(CursorPreparer{})
	preparer.RegisterProvider(OpenCodePreparer{})
	preparer.RegisterProvider(InstructionFilePreparer{ProviderID: "nexight", FileName: "AGENTS.md"})
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
	input = expandConnectorAgentContext(input)
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

	input = p.normalizeCapabilities(input)
	if facts, factsErr := normalizeHostFacts(p.Profile.HostFacts); factsErr == nil {
		input.hostFacts = facts
	}
	input.CLICommand = firstNonEmptyText(input.CLICommand, p.CLICommand, resolveCLICommand(p.StateDir))
	resolver, err := resolveCommandCapabilities(
		ctx,
		p.CommandCatalog,
		workspaceID,
		input.CLICommand,
		input.CommandCapabilityProjection,
	)
	if err != nil {
		return PreparedRuntime{}, err
	}
	input.commandCapabilities = resolver

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

	manifest := NewManifest(ManifestInput{
		AgentSessionID: agentSessionID,
		Provider:       providerID,
		Cwd:            cwd,
		RuntimeRoot:    runtimeRoot,
	})
	resolved, err := resolveCapabilities(ctx, input, p.Profile, p.SkillSources)
	if err != nil {
		return PreparedRuntime{}, err
	}
	input.resolved = resolved
	commandGuide, err := input.commandCapabilities.Guide()
	if err != nil {
		return PreparedRuntime{}, err
	}
	logRuntimePrepareTrace("runtime_prepare.input_normalized", input, map[string]any{
		"cli_command":          input.CLICommand,
		"command_guide_length": len(commandGuide),
	})

	result := ProviderPrepareResult{Cwd: cwd}
	var rtkRuntime sessionRTKRuntime
	if input.RTKSaverMode {
		rtkRuntime, err = prepareSessionRTK(runtimeRoot, func() (string, error) {
			return p.resolveRTKExecutable(ctx)
		})
		if err != nil {
			return PreparedRuntime{}, err
		}
		manifest.RecordManagedFile(rtkRuntime.Executable, "rtk-executable", rtkRuntime.ExecutableCreated)
		manifest.RecordManagedFile(rtkRuntime.Instructions, "rtk-instructions", rtkRuntime.InstructionsCreated)
		input.rtkInstructionsPath = rtkRuntime.Instructions
	}
	if provider := p.provider(input); provider != nil {
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
	if input.RTKSaverMode {
		result.Env = append(result.Env, rtkRuntime.Env...)
	}
	runtimeEnv := defaultRuntimeEnv(input, p.StateDir)
	if input.RTKSaverMode {
		runtimeEnv = prependPathEntry(runtimeEnv, filepath.Dir(rtkRuntime.Executable))
	}
	result.Env = append(runtimeEnv, result.Env...)
	logRuntimePrepareTrace("runtime_prepare.env_prepared", input, map[string]any{
		"env_count": len(result.Env),
	})
	if err := store.SaveManifest(runtimeRoot, manifest); err != nil {
		if result.Cleanup != nil {
			_ = result.Cleanup(ctx)
		}
		return PreparedRuntime{}, err
	}
	if result.Cleanup != nil {
		p.rememberProviderCleanup(workspaceID, agentSessionID, result.Cleanup)
	}
	logRuntimePrepareTrace("runtime_prepare.manifest_saved", input, nil)
	return PreparedRuntime{
		Cwd:        result.Cwd,
		Env:        result.Env,
		MCPServers: cloneMCPServerBindings(input.MCPServers),
	}, nil
}

func (p *DefaultPreparer) resolveRTKExecutable(ctx context.Context) (string, error) {
	if p.RTKExecutableResolver != nil {
		path, err := p.RTKExecutableResolver(ctx)
		if err != nil {
			return "", fmt.Errorf("resolve Tutti-managed rtk executable: %w", err)
		}
		if strings.TrimSpace(path) == "" {
			return "", errors.New("tutti-managed rtk executable is unavailable")
		}
		return path, nil
	}
	return "", errors.New("rtk saver mode requires a Tutti-managed rtk executable resolver")
}

func cloneMCPServerBindings(input []MCPServerBinding) []MCPServerBinding {
	if len(input) == 0 {
		return nil
	}
	result := make([]MCPServerBinding, 0, len(input))
	for _, binding := range input {
		headers := make(map[string]string, len(binding.Headers))
		for key, value := range binding.Headers {
			headers[key] = value
		}
		binding.Headers = headers
		result = append(result, binding)
	}
	return result
}

func (p *DefaultPreparer) RenderSkillBundle(ctx context.Context, input PrepareInput) (SkillBundle, error) {
	input = expandConnectorAgentContext(input)
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
	if facts, factsErr := normalizeHostFacts(p.Profile.HostFacts); factsErr == nil {
		input.hostFacts = facts
	}
	resolver, err := resolveCommandCapabilities(
		ctx,
		p.CommandCatalog,
		workspaceID,
		input.CLICommand,
		input.CommandCapabilityProjection,
	)
	if err != nil {
		return SkillBundle{}, err
	}
	input.commandCapabilities = resolver
	resolved, err := resolveCapabilities(ctx, input, p.Profile, p.SkillSources)
	if err != nil {
		return SkillBundle{}, err
	}
	input.resolved = resolved
	return renderProviderSkillBundle(input)
}

func (p *DefaultPreparer) Cleanup(ctx context.Context, input CleanupInput) error {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return errors.New("agent runtime cleanup requires workspace and session")
	}
	if cleanup := p.providerCleanupFor(workspaceID, agentSessionID); cleanup != nil {
		if err := cleanup(ctx); err != nil {
			return err
		}
		p.forgetProviderCleanup(workspaceID, agentSessionID)
	}
	runtimeRoot, err := p.runtimeStore().RuntimeRoot(workspaceID, agentSessionID)
	if err != nil {
		return err
	}
	if err := recoverMutagenAuthSessions(ctx, p.StateDir, runtimeRoot); err != nil {
		return err
	}
	if input.PreserveRuntimeRoot {
		return nil
	}
	return p.runtimeStore().CleanupRuntime(StoreCleanupInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
	})
}

func providerCleanupKey(workspaceID, agentSessionID string) string {
	return workspaceID + "\x00" + agentSessionID
}

func (p *DefaultPreparer) rememberProviderCleanup(workspaceID, agentSessionID string, cleanup func(context.Context) error) {
	p.cleanupMu.Lock()
	defer p.cleanupMu.Unlock()
	if p.providerCleanup == nil {
		p.providerCleanup = make(map[string]func(context.Context) error)
	}
	key := providerCleanupKey(workspaceID, agentSessionID)
	if _, exists := p.providerCleanup[key]; !exists {
		p.providerCleanup[key] = cleanup
	}
}

func (p *DefaultPreparer) providerCleanupFor(workspaceID, agentSessionID string) func(context.Context) error {
	p.cleanupMu.Lock()
	defer p.cleanupMu.Unlock()
	return p.providerCleanup[providerCleanupKey(workspaceID, agentSessionID)]
}

func (p *DefaultPreparer) forgetProviderCleanup(workspaceID, agentSessionID string) {
	p.cleanupMu.Lock()
	defer p.cleanupMu.Unlock()
	delete(p.providerCleanup, providerCleanupKey(workspaceID, agentSessionID))
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

func (p *DefaultPreparer) provider(input PrepareInput) ProviderPreparer {
	if p == nil {
		return nil
	}
	providerID := strings.TrimSpace(input.Provider)
	if provider := p.providers[providerID]; provider != nil {
		return provider
	}
	if input.ExtensionRuntimePrep != nil {
		return ExtensionRuntimePreparer{}
	}
	if strings.EqualFold(providerID, "acp:kimi-code") {
		return KimiCodePreparer{}
	}
	// Other acp: extensions share a generic instruction+skill preparer; their
	// skill roots arrive via PrepareInput.ExtensionSkillRoots from the
	// extension composer profile, so they need no per-key entry.
	if strings.HasPrefix(providerID, "acp:") {
		return InstructionFilePreparer{}
	}
	return nil
}

func (p *DefaultPreparer) runtimeStore() RuntimeStore {
	if p.Store != nil {
		return p.Store
	}
	return LocalStore{StateDir: p.StateDir}
}

func (p *DefaultPreparer) normalizeCapabilities(input PrepareInput) PrepareInput {
	if input.BrowserUse && p != nil && p.BrowserUseAvailable != nil {
		input.BrowserUse = p.BrowserUseAvailable()
	}
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
	connectorBinDir := ""
	if input.Connector != nil {
		connectorBinDir = input.Connector.CLIBinDir
	}
	if pathEnv := runtimePathEnv(stateDir, connectorBinDir); pathEnv != "" {
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

func runtimePathEnv(stateDir string, connectorBinDir string) string {
	stateDir = strings.TrimSpace(stateDir)
	connectorBinDir = strings.TrimSpace(connectorBinDir)
	if stateDir == "" && connectorBinDir == "" {
		return ""
	}
	binDirs := make([]string, 0, 2)
	if stateDir != "" {
		binDirs = append(binDirs, filepath.Join(stateDir, "bin"))
	}
	if connectorBinDir != "" {
		binDirs = append(binDirs, connectorBinDir)
	}
	currentPath := os.Getenv("PATH")
	entries := filepath.SplitList(currentPath)
	for _, binDir := range binDirs {
		present := false
		for _, entry := range entries {
			if filepath.Clean(entry) == filepath.Clean(binDir) {
				present = true
				break
			}
		}
		if !present {
			entries = append([]string{binDir}, entries...)
		}
	}
	return "PATH=" + strings.Join(entries, string(os.PathListSeparator))
}

func prependPathEntry(env []string, entry string) []string {
	entry = strings.TrimSpace(entry)
	if entry == "" {
		return env
	}
	for index, value := range env {
		if !strings.HasPrefix(value, "PATH=") {
			continue
		}
		entries := filepath.SplitList(strings.TrimPrefix(value, "PATH="))
		for _, candidate := range entries {
			if filepath.Clean(candidate) == filepath.Clean(entry) {
				return env
			}
		}
		env[index] = "PATH=" + strings.Join(append([]string{entry}, entries...), string(os.PathListSeparator))
		return env
	}
	return append(env, "PATH="+entry+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func expandConnectorAgentContext(input PrepareInput) PrepareInput {
	if input.Connector == nil {
		return input
	}
	input.MCPServers = append(cloneMCPServerBindings(input.MCPServers), cloneMCPServerBindings(input.Connector.MCPServers)...)
	input.ConnectorRoutingHints = append([]ConnectorRoutingHint(nil), input.Connector.RoutingHints...)
	return input
}
