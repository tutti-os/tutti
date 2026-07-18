package agentcontext

import (
	"context"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const appID = "agent-context"

type AgentSessions interface {
	CancelTurn(context.Context, string, string, string) (agentservice.CancelTurnResult, error)
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	Get(context.Context, string, string) (agentservice.Session, error)
	GetComposerOptions(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	GetSkillBundle(context.Context, string, agentservice.SkillBundleInput) (agentservice.SkillBundle, error)
	List(context.Context, string) ([]agentservice.Session, error)
	ListActivePeers(context.Context, string) (agentservice.ActivePeers, error)
	ListMessages(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	ListProviderAvailability(context.Context, agentservice.ProviderAvailabilityInput) ([]agentservice.ProviderAvailability, error)
	LocalAttachmentPath(context.Context, string, string, string, string) (string, error)
	Respond(context.Context, agentservice.RespondInput) (agentservice.RespondResult, error)
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

func (Provider) AppID() string {
	return appID
}

func (p Provider) Commands() []cliservice.Command {
	return []cliservice.Command{
		p.newAgentsCommand(),
		p.newLegacyProvidersCommand(),
		p.newComposerOptionsCommand(),
		p.newSkillBundleCommand(),
		p.newLegacyCodexStartCommand(),
		p.newLegacyClaudeStartCommand(),
		p.newStartCommand(),
		p.newGetCommand(),
		p.newOpenCommand(),
		p.newSendCommand(),
		p.newRespondCommand(),
		p.newCancelCommand(),
		p.newSessionsCommand([]string{"agent", "sessions"}, appID+".agent.sessions"),
		p.newWaitCommand(),
		p.newSessionSummaryCommand(),
		p.newTurnResourcesCommand(),
		p.newActivePeersCommand(),
	}
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
	return agenttargetbiz.EnabledTargets(targets), nil
}

func (p Provider) resolveEnabledAgentTarget(ctx context.Context, agentID string) (agenttargetbiz.Target, error) {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return agenttargetbiz.Target{}, fmt.Errorf("%w: agent id is required; run agent list --json", cliservice.ErrInvalidInput)
	}
	targets, err := p.enabledAgentTargets(ctx)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	for _, target := range targets {
		if target.ID == agentID {
			return target, nil
		}
	}
	return agenttargetbiz.Target{}, fmt.Errorf("%w: enabled agent %q was not found; run agent list --json", cliservice.ErrInvalidInput, agentID)
}
