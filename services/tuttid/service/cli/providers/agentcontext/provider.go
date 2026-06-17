package agentcontext

import (
	"context"
	"strings"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentgui"
	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

const appID = "agent-context"

const (
	codexAgentAppID      = "agent-codex"
	claudeCodeAgentAppID = "agent-claude-code"
)

type AgentSessions interface {
	Cancel(context.Context, string, string) (agentservice.CancelSessionResult, error)
	Create(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	Get(context.Context, string, string) (agentservice.Session, error)
	GetComposerOptions(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	List(context.Context, string) ([]agentservice.Session, error)
	ListActivePeers(context.Context, string) (agentservice.ActivePeers, error)
	ListMessages(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	ListProviderAvailability(context.Context, agentservice.ProviderAvailabilityInput) ([]agentservice.ProviderAvailability, error)
	SendInput(context.Context, string, string, agentservice.SendInput) (agentservice.Session, error)
}

type AgentGUILaunchPublisher interface {
	PublishAgentGUILaunchRequested(context.Context, agentgui.LaunchRequest) error
}

type DesktopPreferencesReader interface {
	Get(context.Context) (preferencesbiz.DesktopPreferences, error)
}

type Provider struct {
	workspaces      cliservice.WorkspaceCatalog
	sessions        AgentSessions
	launchPublisher AgentGUILaunchPublisher
	preferences     DesktopPreferencesReader
}

func NewProvider(workspaces cliservice.WorkspaceCatalog, sessions AgentSessions) Provider {
	return Provider{workspaces: workspaces, sessions: sessions}
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
		p.newProvidersCommand(),
		p.newComposerOptionsCommand(),
		p.newProviderStartCommand(providerStartCommandSpec{
			AppID:       codexAgentAppID,
			AppName:     "Codex",
			CommandID:   appID + ".codex.start",
			Description: "Start a Codex agent session in the current workspace. Use --show to request AgentGUI activation.",
			Path:        []string{"codex", "start"},
			Provider:    agentproviderbiz.Codex,
			Summary:     "Start a Codex agent session",
		}),
		p.newProviderStartCommand(providerStartCommandSpec{
			AppID:       claudeCodeAgentAppID,
			AppName:     "Claude Code",
			CommandID:   appID + ".claude.start",
			Description: "Start a Claude Code agent session in the current workspace. Use --show to request AgentGUI activation.",
			Path:        []string{"claude", "start"},
			Provider:    agentproviderbiz.ClaudeCode,
			Summary:     "Start a Claude Code agent session",
		}),
		p.newStartCommand(),
		p.newGetCommand(),
		p.newOpenCommand(),
		p.newSendCommand(),
		p.newCancelCommand(),
		p.newSessionsCommand([]string{"agent", "list"}, appID+".agent.list"),
		p.newSessionsCommand([]string{"agent", "sessions"}, appID+".agent.sessions"),
		p.newSessionMessagesCommand([]string{"agent", "session", "messages"}, appID+".agent.session.messages"),
		p.newSessionMessagesCommand([]string{"agent", "session-summary"}, appID+".agent.session-summary"),
		p.newActivePeersCommand(),
	}
}

func (p Provider) workspaceID(ctx context.Context, request cliservice.InvokeRequest) (string, error) {
	return cliservice.ResolveWorkspaceID(ctx, p.workspaces, request.Context.WorkspaceID)
}

func (p Provider) requireSessions() error {
	if p.sessions == nil {
		return agentservice.ErrInvalidArgument
	}
	return nil
}

func sessionValue(session agentservice.Session) map[string]any {
	value := map[string]any{
		"id":             strings.TrimSpace(session.ID),
		"provider":       strings.TrimSpace(session.Provider),
		"cwd":            strings.TrimSpace(session.Cwd),
		"status":         strings.TrimSpace(session.Status),
		"visible":        session.Visible,
		"resumable":      session.Resumable,
		"runtimeContext": session.RuntimeContext,
		"createdAt":      session.CreatedAt,
		"updatedAt":      session.UpdatedAt,
		"endedAt":        session.EndedAt,
		"lastError":      session.LastError,
	}
	if session.Title != nil {
		value["title"] = *session.Title
	}
	if session.Settings != nil {
		value["settings"] = agentservice.ComposerSettingsToMap(*session.Settings)
	}
	value["permissionConfig"] = permissionConfigValue(session.PermissionConfig)
	return value
}

func sessionValues(sessions []agentservice.Session) []any {
	values := make([]any, 0, len(sessions))
	for _, session := range sessions {
		values = append(values, sessionValue(session))
	}
	return values
}

func messageValue(message agentservice.SessionMessage) map[string]any {
	return map[string]any{
		"id":                message.ID,
		"agentSessionId":    strings.TrimSpace(message.AgentSessionID),
		"messageId":         strings.TrimSpace(message.MessageID),
		"turnId":            strings.TrimSpace(message.TurnID),
		"role":              strings.TrimSpace(message.Role),
		"kind":              strings.TrimSpace(message.Kind),
		"status":            strings.TrimSpace(message.Status),
		"payload":           message.Payload,
		"occurredAtUnixMs":  message.OccurredAtUnixMS,
		"startedAtUnixMs":   message.StartedAtUnixMS,
		"completedAtUnixMs": message.CompletedAtUnixMS,
		"createdAtUnixMs":   message.CreatedAtUnixMS,
		"updatedAtUnixMs":   message.UpdatedAtUnixMS,
		"version":           message.Version,
	}
}

func messageValues(messages []agentservice.SessionMessage) []any {
	values := make([]any, 0, len(messages))
	for _, message := range messages {
		values = append(values, messageValue(message))
	}
	return values
}
