package implementationhost

import (
	"slices"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	connectorartifact "github.com/tutti-os/tutti/packages/connector/runtime/artifact"
)

func TestRouteRegistryProjectsDetachedConnectorMetadata(t *testing.T) {
	route := &connectorRoute{
		id: "account-1\x00calendar", releaseDigest: "digest",
		generation:   market.HostGeneration{BootEpoch: "boot-1", Generation: 1},
		connectorKey: "calendar", displayName: "Calendar", description: "Manage meetings",
		routingAliases: []string{"日历"}, skillRoot: "/verified/skills",
		skills:   []connectorartifact.SkillSummary{{Name: "standup", Title: "Standup", Description: "Prepare a standup"}},
		mcpTools: map[string]registeredMCPTool{"calendar_list": {}}, cliCommand: "tutti-connector-calendar",
		processes: connectorruntime.NewProcessGroup(),
	}
	table := connectorruntime.NewRouteTable()
	if err := table.Commit(route); err != nil {
		t.Fatal(err)
	}
	registry := NewRouteRegistry()
	registry.attach(table)

	summaries := registry.ConnectorSummaries()
	if len(summaries) != 1 || summaries[0].Key != "calendar" || len(summaries[0].Skills) != 1 ||
		len(summaries[0].Interfaces) != 2 || summaries[0].Interfaces[0].Kind != "mcp" || summaries[0].Interfaces[1].Kind != "cli" {
		t.Fatalf("summaries = %#v", summaries)
	}
	hints := registry.RoutingHints()
	if len(hints) != 1 || hints[0].SkillRoot != "/verified/skills" || !slices.Equal(hints[0].Aliases, []string{"日历"}) {
		t.Fatalf("hints = %#v", hints)
	}
	summaries[0].Skills[0].Name = "mutated"
	hints[0].Aliases[0] = "mutated"
	if registry.ConnectorSummaries()[0].Skills[0].Name != "standup" || registry.RoutingHints()[0].Aliases[0] != "日历" {
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
