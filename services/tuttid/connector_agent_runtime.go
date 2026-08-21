package main

import (
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	connectorimplementation "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	connectormcpservice "github.com/tutti-os/tutti/services/tuttid/service/connector/mcp"
)

// connectorAgentRuntime is the stable composition port shared by the Agent
// Service and Host. The route registry may change after construction, but the
// port itself is ready before Agent Host recovery begins.
type connectorAgentRuntime struct {
	routes    *connectorimplementation.RouteRegistry
	server    connectorSessionBinder
	cliBinDir string
}

type connectorSessionBinder interface {
	Binding(string, string) (connectormcpservice.Binding, error)
	Revoke(string, string)
	RevokeAll()
}

func (runtime *connectorAgentRuntime) RoutingHints() []runtimeprep.ConnectorRoutingHint {
	if runtime == nil || runtime.routes == nil {
		return nil
	}
	routes := runtime.routes.RoutingHints()
	hints := make([]runtimeprep.ConnectorRoutingHint, 0, len(routes))
	for _, route := range routes {
		hints = append(hints, runtimeprep.ConnectorRoutingHint{
			ConnectorKey: route.Key,
			DisplayName:  route.DisplayName,
			Aliases:      append([]string(nil), route.Aliases...),
			SkillRoot:    route.SkillRoot,
		})
	}
	return hints
}

func (runtime *connectorAgentRuntime) BindSession(workspaceID, agentSessionID string) (runtimeprep.ConnectorAgentContext, error) {
	binding, err := runtime.server.Binding(workspaceID, agentSessionID)
	if err != nil {
		return runtimeprep.ConnectorAgentContext{}, err
	}
	hints := runtime.RoutingHints()
	skillRoots := make([]string, 0, len(hints))
	for _, hint := range hints {
		if hint.SkillRoot != "" {
			skillRoots = append(skillRoots, hint.SkillRoot)
		}
	}
	return runtimeprep.ConnectorAgentContext{
		MCPServers:   []runtimeprep.MCPServerBinding{{Name: binding.Name, Type: binding.Type, URL: binding.URL, Headers: binding.Headers}},
		RoutingHints: hints, CLIBinDir: runtime.cliBinDir, SkillRoots: skillRoots,
		RuntimeRevision: runtime.routes.Revision(),
	}, nil
}

func (runtime *connectorAgentRuntime) RevokeSession(workspaceID, agentSessionID string) {
	if runtime != nil && runtime.server != nil {
		runtime.server.Revoke(workspaceID, agentSessionID)
	}
}

func (runtime *connectorAgentRuntime) RevokeAll() {
	if runtime != nil && runtime.server != nil {
		runtime.server.RevokeAll()
	}
}
