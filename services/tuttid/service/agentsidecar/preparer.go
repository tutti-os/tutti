package agentsidecar

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	agentsidecarbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentsidecar"
	agentsidecardata "github.com/tutti-os/tutti/services/tuttid/data/agentsidecar"
)

var ErrCwdNotDirectory = errors.New("agent runtime cwd is not a directory")

type DefaultPreparer struct {
	StateDir       string
	CLICommand     string
	CommandCatalog CommandCatalog
	Store          RuntimeStore
	providers      map[string]ProviderPreparer
}

func NewDefaultPreparer(stateDir string) *DefaultPreparer {
	preparer := &DefaultPreparer{
		StateDir:  stateDir,
		providers: make(map[string]ProviderPreparer),
	}
	preparer.RegisterProvider(CodexPreparer{})
	preparer.RegisterProvider(ClaudeCodePreparer{})
	preparer.RegisterProvider(GeminiPreparer{})
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
	if err := ensureCwdDirectory(cwd); err != nil {
		return PreparedRuntime{}, err
	}

	store := p.runtimeStore()
	runtimeRoot, err := store.RuntimeRoot(workspaceID, agentSessionID)
	if err != nil {
		return PreparedRuntime{}, err
	}
	if err := store.EnsureRuntimeRoot(runtimeRoot); err != nil {
		return PreparedRuntime{}, err
	}

	manifest := agentsidecarbiz.NewManifest(agentsidecarbiz.ManifestInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Provider:       providerID,
		Cwd:            cwd,
		RuntimeRoot:    runtimeRoot,
	})
	input.WorkspaceID = workspaceID
	input.AgentSessionID = agentSessionID
	input.Provider = providerID
	input.Cwd = cwd
	input.CLICommand = firstNonEmptyText(input.CLICommand, p.CLICommand, resolveCLICommand(p.StateDir))
	input.CommandGuide = commandGuideFromCatalog(ctx, p.CommandCatalog, workspaceID, input.CLICommand)

	result := ProviderPrepareResult{Cwd: cwd}
	if provider := p.provider(providerID); provider != nil {
		result, err = provider.Prepare(ctx, ProviderPrepareInput{
			PrepareInput: input,
			RuntimeRoot:  runtimeRoot,
			Manifest:     manifest,
			Store:        store,
		})
		if err != nil {
			return PreparedRuntime{}, err
		}
	}
	if result.Cwd == "" {
		result.Cwd = cwd
	}
	result.Env = append(defaultRuntimeEnv(input, p.StateDir), result.Env...)
	if err := store.SaveManifest(runtimeRoot, manifest); err != nil {
		return PreparedRuntime{}, err
	}
	return PreparedRuntime(result), nil
}

func (p *DefaultPreparer) Cleanup(_ context.Context, input CleanupInput) error {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return errors.New("agent runtime cleanup requires workspace and session")
	}
	return p.runtimeStore().CleanupRuntime(agentsidecarbiz.CleanupInput{
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
	return agentsidecardata.LocalStore{StateDir: p.StateDir}
}

func defaultRuntimeEnv(input PrepareInput, stateDir string) []string {
	env := []string{
		"TUTTI_WORKSPACE_ID=" + strings.TrimSpace(input.WorkspaceID),
		"TUTTI_AGENT_SESSION_ID=" + strings.TrimSpace(input.AgentSessionID),
		"TUTTI_AGENT_PROVIDER=" + strings.TrimSpace(input.Provider),
	}
	if pathEnv := runtimePathEnv(stateDir); pathEnv != "" {
		env = append(env, pathEnv)
	}
	// Browser use is delivered as a default MCP server to every agent provider,
	// so it is advertised here in the shared runtime env rather than per-provider.
	env = append(env, browserUseEnv(input.BrowserUse)...)
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
