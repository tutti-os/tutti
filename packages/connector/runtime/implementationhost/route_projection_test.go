package implementationhost

import (
	"slices"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	connectorartifact "github.com/tutti-os/tutti/packages/connector/runtime/artifact"
)

func TestRouteRegistryProjectsDetachedConnectorMetadata(t *testing.T) {
	route := &connectorRoute{
		id: "account-1\x00calendar", connectionID: "account-1", connectorVersion: "1.2.3", releaseDigest: "digest",
		generation:   market.HostGeneration{BootEpoch: "boot-1", Generation: 1},
		connectorKey: "calendar", displayName: "Calendar", description: "Manage meetings",
		routingAliases: []string{"日历"}, skillRoot: "/verified/skills",
		skills:   []connectorartifact.SkillSummary{{Name: "standup", Title: "Standup", Description: "Prepare a standup"}},
		mcpTools: map[string]registeredMCPTool{"calendar_list": {}}, cliCommand: "tutti-connector-calendar", cliInvocationCommand: "calendar-cli",
		cliContractHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		cliCommands: []market.CLICommand{{Name: "events", Arguments: []string{"events"},
			InputSchema: map[string]any{"type": "object"}, TimeoutMS: 10_000}},
		processes: connectorruntime.NewProcessGroup(),
	}
	table := connectorruntime.NewRouteTable()
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	registry := NewRouteRegistry()
	registry.attach(table)

	summaries := registry.ConnectorSummaries()
	if len(summaries) != 1 || summaries[0].Key != "calendar" || summaries[0].Version != "1.2.3" || len(summaries[0].Skills) != 1 ||
		len(summaries[0].Interfaces) != 2 || summaries[0].Interfaces[0].Kind != "mcp" || summaries[0].Interfaces[1].Kind != "cli" {
		t.Fatalf("summaries = %#v", summaries)
	}
	if summaries[0].Interfaces[1].Command != "calendar-cli" {
		t.Fatalf("CLI command = %q", summaries[0].Interfaces[1].Command)
	}
	hints := registry.RoutingHints()
	if len(hints) != 1 || hints[0].SkillRoot != "/verified/skills" || !slices.Equal(hints[0].Aliases, []string{"日历"}) {
		t.Fatalf("hints = %#v", hints)
	}
	routes := registry.Routes()
	if len(routes) != 1 || routes[0].ConnectionID != "account-1" || routes[0].ConnectorVersion != "1.2.3" ||
		routes[0].ReleaseDigest != "digest" || routes[0].CLIContractHash == "" || len(routes[0].CLICommands) != 1 {
		t.Fatalf("routes = %#v", routes)
	}
	summaries[0].Skills[0].Name = "mutated"
	hints[0].Aliases[0] = "mutated"
	routes[0].CLICommands[0].Arguments[0] = "mutated"
	routes[0].CLICommands[0].InputSchema["type"] = "mutated"
	refetchedRoute := registry.Routes()[0]
	if registry.ConnectorSummaries()[0].Skills[0].Name != "standup" || registry.RoutingHints()[0].Aliases[0] != "日历" ||
		refetchedRoute.CLICommands[0].Arguments[0] != "events" || refetchedRoute.CLICommands[0].InputSchema["type"] != "object" {
		t.Fatal("route projection leaked mutable state")
	}
}

func TestCommittedRouteSummaryDoesNotDependOnCapabilityPublication(t *testing.T) {
	route := &connectorRoute{
		id: "account-1\x00calendar", releaseDigest: "digest",
		generation:   market.HostGeneration{BootEpoch: "boot-1", Generation: 1},
		connectorKey: "calendar", displayName: "Calendar", description: "Manage meetings",
		skills:   []connectorartifact.SkillSummary{{Name: "standup", Title: "Standup", Description: "Prepare a standup"}},
		mcpTools: map[string]registeredMCPTool{"calendar_list": {}}, processes: connectorruntime.NewProcessGroup(),
		readiness: market.RuntimeReadiness{State: market.RuntimeReadinessReady,
			Interfaces: []market.InterfaceReadiness{{Kind: "mcp", State: market.RuntimeReadinessReady}}},
	}
	table := connectorruntime.NewRouteTable()
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	table.SetPublished(false)
	registry := NewRouteRegistry()
	registry.attach(table)
	if summaries := registry.ConnectorSummaries(); len(summaries) != 0 {
		t.Fatalf("published summaries = %#v", summaries)
	}
	summary := connectorSummaryFromDescriptor(routeDescriptor(route))
	if summary.Key != "calendar" || len(summary.Skills) != 1 || len(summary.Interfaces) != 1 {
		t.Fatalf("committed summary = %#v", summary)
	}
}
