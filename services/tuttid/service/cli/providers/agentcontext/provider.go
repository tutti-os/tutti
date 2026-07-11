package agentcontext

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const appID = "agent-context"

const (
	codexAgentAppID      = "agent-codex"
	claudeCodeAgentAppID = "agent-claude-code"
	tuttiAgentAppID      = "agent-tutti-agent"
)

type AgentSessions interface {
	Cancel(context.Context, string, string) (agentservice.CancelSessionResult, error)
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	Get(context.Context, string, string) (agentservice.Session, error)
	GetComposerOptions(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	GetSkillBundle(context.Context, string, agentservice.SkillBundleInput) (agentservice.SkillBundle, error)
	List(context.Context, string) ([]agentservice.Session, error)
	ListActivePeers(context.Context, string) (agentservice.ActivePeers, error)
	ListMessages(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	ListProviderAvailability(context.Context, agentservice.ProviderAvailabilityInput) ([]agentservice.ProviderAvailability, error)
	LocalAttachmentPath(context.Context, string, string, string, string) (string, error)
	SendInput(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error)
	Wait(context.Context, agentservice.WaitInput) (agentservice.WaitResult, error)
}

type AgentGUILaunchPublisher interface {
	PublishAgentGUILaunchRequested(context.Context, agentgui.LaunchRequest) error
}

type DesktopPreferencesReader interface {
	Get(context.Context) (preferencesbiz.DesktopPreferences, error)
}

type AgentTargetLister interface {
	List(context.Context) ([]agenttargetbiz.Target, error)
}

type Provider struct {
	workspaces      cliservice.WorkspaceCatalog
	sessions        AgentSessions
	launchPublisher AgentGUILaunchPublisher
	preferences     DesktopPreferencesReader
	agentTargets    AgentTargetLister
}

func NewProviderWithLaunchPublisher(
	workspaces cliservice.WorkspaceCatalog,
	sessions AgentSessions,
	launchPublisher AgentGUILaunchPublisher,
	preferences ...DesktopPreferencesReader,
) Provider {
	var preferencesReader DesktopPreferencesReader
	if len(preferences) > 0 {
		preferencesReader = preferences[0]
	}
	return Provider{
		workspaces:      workspaces,
		sessions:        sessions,
		launchPublisher: launchPublisher,
		preferences:     preferencesReader,
	}
}

func NewProviderWithAgentTargets(
	workspaces cliservice.WorkspaceCatalog,
	sessions AgentSessions,
	launchPublisher AgentGUILaunchPublisher,
	agentTargets AgentTargetLister,
	preferences ...DesktopPreferencesReader,
) Provider {
	provider := NewProviderWithLaunchPublisher(workspaces, sessions, launchPublisher, preferences...)
	provider.agentTargets = agentTargets
	return provider
}

func (Provider) AppID() string {
	return appID
}

func (p Provider) Commands() []cliservice.Command {
	commands := make([]cliservice.Command, 0, 18)
	if p.agentTargets != nil {
		commands = append(commands,
			p.newProvidersCommand(),
			p.newComposerOptionsCommand(),
			p.newStartCommand(),
		)
	}
	commands = append(commands,
		p.newSkillBundleCommand(),
		p.newProviderStartCommand(providerStartCommandSpec{
			AppID:         codexAgentAppID,
			AppName:       "Codex",
			CommandID:     appID + ".codex.start",
			Description:   "Start a Codex agent session in the current workspace. Use --show to request AgentGUI activation.",
			Path:          []string{"codex", "start"},
			Provider:      agentproviderbiz.Codex,
			AgentTargetID: agenttargetbiz.IDLocalCodex,
			Summary:       "Start a Codex agent session",
		}),
		p.newProviderStartCommand(providerStartCommandSpec{
			AppID:         claudeCodeAgentAppID,
			AppName:       "Claude Code",
			CommandID:     appID + ".claude.start",
			Description:   "Start a Claude Code agent session in the current workspace. Use --show to request AgentGUI activation.",
			Path:          []string{"claude", "start"},
			Provider:      agentproviderbiz.ClaudeCode,
			AgentTargetID: agenttargetbiz.IDLocalClaudeCode,
			Summary:       "Start a Claude Code agent session",
		}),
		p.newProviderStartCommand(providerStartCommandSpec{
			AppID:         tuttiAgentAppID,
			AppName:       "Tutti Agent",
			CommandID:     appID + ".tutti-agent.start",
			Description:   "Start a Tutti Agent session in the current workspace. Use --show to request AgentGUI activation.",
			Path:          []string{"tutti-agent", "start"},
			Provider:      agentproviderbiz.TuttiAgent,
			AgentTargetID: agenttargetbiz.IDLocalTuttiAgent,
			Summary:       "Start a Tutti Agent session",
		}),
		p.newGetCommand(),
		p.newOpenCommand(),
		p.newSendCommand(),
		p.newCancelCommand(),
		p.newSessionsCommand([]string{"agent", "sessions"}, appID+".agent.sessions"),
		p.newWaitCommand(),
		p.newSessionSummaryCommand(),
		p.newTurnResourcesCommand(),
		p.newActivePeersCommand(),
	)
	return commands
}

func (p Provider) FilterCapabilities(ctx context.Context, _ cliservice.InvokeContext, capabilities []cliservice.Capability) []cliservice.Capability {
	if len(capabilities) == 0 || !hasProviderAgentAppCapability(capabilities) {
		return capabilities
	}
	availableProviders := p.availableProviders(ctx)
	result := make([]cliservice.Capability, 0, len(capabilities))
	for _, capability := range capabilities {
		provider, ok := providerAgentAppCapabilityProvider(capability)
		if !ok || availableProviders[provider] {
			result = append(result, capability)
		}
	}
	return result
}

func hasProviderAgentAppCapability(capabilities []cliservice.Capability) bool {
	for _, capability := range capabilities {
		if _, ok := providerAgentAppCapabilityProvider(capability); ok {
			return true
		}
	}
	return false
}

func providerAgentAppCapabilityProvider(capability cliservice.Capability) (string, bool) {
	if capability.Source.Kind != cliservice.CapabilitySourceApp {
		return "", false
	}
	switch strings.TrimSpace(capability.Source.AppID) {
	case codexAgentAppID:
		return agentproviderbiz.Codex, true
	case claudeCodeAgentAppID:
		return agentproviderbiz.ClaudeCode, true
	case tuttiAgentAppID:
		return agentproviderbiz.TuttiAgent, true
	default:
		return "", false
	}
}

func (p Provider) availableProviders(ctx context.Context) map[string]bool {
	available := map[string]bool{}
	if p.sessions == nil {
		return available
	}
	var enabled map[string]bool
	if p.agentTargets != nil {
		targets, err := p.enabledAgentTargets(ctx)
		if err != nil {
			return available
		}
		enabled = make(map[string]bool, len(targets))
		for _, target := range targets {
			enabled[target.Provider] = true
		}
	}
	items, err := p.sessions.ListProviderAvailability(ctx, agentservice.ProviderAvailabilityInput{})
	if err != nil {
		return available
	}
	for _, item := range items {
		if item.Status != agentservice.ProviderAvailabilityAvailable {
			continue
		}
		provider := agentproviderbiz.Normalize(item.Provider)
		if provider != "" && (enabled == nil || enabled[provider]) {
			available[provider] = true
		}
	}
	return available
}

func (p Provider) requireSessions() error {
	if p.sessions == nil {
		return agentservice.ErrInvalidArgument
	}
	return nil
}

func (p Provider) enabledAgentTargets(ctx context.Context) ([]agenttargetbiz.Target, error) {
	if p.agentTargets == nil {
		return nil, agentservice.ErrInvalidArgument
	}
	targets, err := p.agentTargets.List(ctx)
	if err != nil {
		return nil, err
	}
	return agenttargetbiz.EnabledTargetsByProvider(targets), nil
}

func (p Provider) resolveEnabledAgentTarget(ctx context.Context, provider string) (agenttargetbiz.Target, error) {
	canonicalProvider := agentproviderbiz.Normalize(provider)
	if canonicalProvider == "" {
		return agenttargetbiz.Target{}, agentservice.ErrInvalidArgument
	}
	targets, err := p.enabledAgentTargets(ctx)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	target, ok := agenttargetbiz.EnabledTargetForProvider(targets, canonicalProvider)
	if !ok {
		return agenttargetbiz.Target{}, &agentservice.ProviderUnavailableError{
			Provider:   canonicalProvider,
			ReasonCode: "agent_provider_not_enabled",
			Message:    "agent provider is not enabled",
		}
	}
	return target, nil
}
