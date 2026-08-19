package implementationhost

import market "github.com/tutti-os/tutti/packages/connector/daemon/core"

type SkillSummary = market.ConnectorSkillSummary
type ConnectorSummary = market.ConnectorSummary
type ConnectorInterfaceSummary = market.ConnectorInterfaceSummary

// ConnectorRoutingHint is a bounded, non-secret projection of one active
// route for Agent runtime preparation.
type ConnectorRoutingHint struct {
	Key         string
	DisplayName string
	Aliases     []string
	SkillRoot   string
}

// ConnectorSummaries returns immutable discovery metadata already validated
// before each route was committed. It never rescans installed artifacts.
func (registry *RouteRegistry) ConnectorSummaries() []ConnectorSummary {
	routes := registry.Routes()
	connectors := make([]ConnectorSummary, 0, len(routes))
	for _, route := range routes {
		connectors = append(connectors, connectorSummaryFromDescriptor(route))
	}
	return connectors
}

func connectorSummaryFromDescriptor(route RouteDescriptor) ConnectorSummary {
	interfaces := make([]ConnectorInterfaceSummary, 0, 2)
	if route.HasMCP {
		interfaces = append(interfaces, ConnectorInterfaceSummary{Kind: "mcp", ServerName: "connector",
			ToolPrefix: route.ConnectorKey + "_", Status: string(route.InterfaceState("mcp"))})
	}
	if route.CLIInvocationCommand != "" {
		interfaces = append(interfaces, ConnectorInterfaceSummary{Kind: "cli", Command: route.CLIInvocationCommand,
			Status: string(route.InterfaceState("cli"))})
	}
	return ConnectorSummary{Key: route.ConnectorKey, Version: route.ConnectorVersion, Name: route.DisplayName, Description: route.Description,
		Skills: append([]SkillSummary(nil), route.Skills...), Interfaces: interfaces}
}

// RoutingHints returns a detached snapshot for Agent runtime preparation.
func (registry *RouteRegistry) RoutingHints() []ConnectorRoutingHint {
	routes := registry.Routes()
	hints := make([]ConnectorRoutingHint, 0, len(routes))
	for _, route := range routes {
		hints = append(hints, ConnectorRoutingHint{
			Key: route.ConnectorKey, DisplayName: route.DisplayName,
			Aliases: append([]string(nil), route.RoutingAliases...), SkillRoot: route.SkillRoot,
		})
	}
	return hints
}
