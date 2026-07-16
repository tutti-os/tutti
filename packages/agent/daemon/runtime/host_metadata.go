package agentruntime

import (
	"context"
	"strings"
)

const (
	defaultWorkspaceEnvName         = "TUTTI_WORKSPACE_ID"
	defaultOpenClawSessionKeyPrefix = "agent:main:tsh-"
)

type ClientInfo struct {
	Name    string
	Title   string
	Version string
}

type HostMetadata struct {
	ClientInfo               ClientInfo
	WorkspaceEnvName         string
	OpenClawSessionKeyPrefix string
}

type ControllerOptions struct {
	HostMetadata                HostMetadata
	ProviderCommandResolver     ProviderCommandResolver
	ProviderLaunchPreparer      ProviderLaunchPreparer
	AdapterResolver             AdapterResolver
	SharedAgentAccessController SharedAgentAccessController
	SharedAgentAccessAuditor    SharedAgentAccessAuditor
}

type AdapterResolveInput struct {
	Provider          string
	AgentTargetID     string
	CWD               string
	ProviderTargetRef map[string]any
}

type AdapterResolver interface {
	ResolveAdapter(context.Context, AdapterResolveInput) (Adapter, error)
}

type ProviderCommand struct {
	Command []string
	Env     []string
}

type ProviderCommandResolver func(context.Context, string) (ProviderCommand, error)

func LegacyHostMetadata() HostMetadata {
	return HostMetadata{
		ClientInfo: ClientInfo{
			Name:    "tsh-desktop",
			Title:   "tsh",
			Version: "0.1.0",
		},
		WorkspaceEnvName:         defaultWorkspaceEnvName,
		OpenClawSessionKeyPrefix: defaultOpenClawSessionKeyPrefix,
	}
}

func normalizeHostMetadata(input HostMetadata) HostMetadata {
	defaults := LegacyHostMetadata()
	out := input
	if strings.TrimSpace(out.ClientInfo.Name) == "" {
		out.ClientInfo.Name = defaults.ClientInfo.Name
	}
	if strings.TrimSpace(out.ClientInfo.Title) == "" {
		out.ClientInfo.Title = defaults.ClientInfo.Title
	}
	if strings.TrimSpace(out.ClientInfo.Version) == "" {
		out.ClientInfo.Version = defaults.ClientInfo.Version
	}
	if strings.TrimSpace(out.WorkspaceEnvName) == "" {
		out.WorkspaceEnvName = defaults.WorkspaceEnvName
	}
	if strings.TrimSpace(out.OpenClawSessionKeyPrefix) == "" {
		out.OpenClawSessionKeyPrefix = defaults.OpenClawSessionKeyPrefix
	}
	return out
}

func (m HostMetadata) clientInfoParams() map[string]any {
	return map[string]any{
		"name":    m.ClientInfo.Name,
		"title":   m.ClientInfo.Title,
		"version": m.ClientInfo.Version,
	}
}

func workspaceEnv(session Session, host HostMetadata) []string {
	roomID := strings.TrimSpace(session.RoomID)
	if roomID == "" {
		return nil
	}
	envName := strings.TrimSpace(host.WorkspaceEnvName)
	if envName == "" {
		return nil
	}
	return []string{envName + "=" + roomID}
}
