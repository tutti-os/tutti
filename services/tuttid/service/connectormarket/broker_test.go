package connectormarket

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestConnectorBrokerExposesOnlyNativeConnectorDiscovery(t *testing.T) {
	host, commands, connector, generation := testCLIHost(t, &connectorProcessStub{})
	connector.Release.Manifest.AgentRouting = &market.AgentRouting{Aliases: []string{"飞书", "Feishu"}}
	root := host.artifacts.(preparedResolverStub).receipt.PreparedPath
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation}); err != nil {
		t.Fatal(err)
	}
	skillDir := filepath.Join(root, "skills", "diagnostic")
	if err := os.MkdirAll(skillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tutti.connector.json"), []byte(`{"name":{"en-US":"Demo Package"},"description":{"en-US":"Package description"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: run-diagnostic\ndescription: Run one diagnostic.\n---\n\n# Run Diagnostic\n\nUse the broker.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker, err := NewConnectorBroker(commands)
	if err != nil {
		t.Fatal(err)
	}
	if capabilities := broker.Capabilities(context.Background(), cliservice.InvokeContext{}); len(capabilities) != 1 || capabilities[0].ID != connectorAvailableCommandID {
		t.Fatalf("broker capabilities = %#v", capabilities)
	}
	available, err := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorAvailableCommandID})
	if err != nil {
		t.Fatal(err)
	}
	connectors, ok := available.Value["connectors"].([]implementationhost.ConnectorSummary)
	if !ok || len(connectors) != 1 || connectors[0].Name != connector.Release.Manifest.DisplayName || len(connectors[0].Skills) != 1 ||
		connectors[0].Skills[0].Name != "run-diagnostic" || connectors[0].Skills[0].Description != "Run one diagnostic." ||
		len(connectors[0].Interfaces) != 1 || connectors[0].Interfaces[0].Kind != "cli" ||
		connectors[0].Interfaces[0].Command != "tutti-connector-github" {
		t.Fatalf("available = %#v", available.Value)
	}
	hints := broker.RoutingHints()
	if len(hints) != 1 || hints[0].Key != "github" || hints[0].DisplayName != connector.Release.Manifest.DisplayName ||
		len(hints[0].Aliases) != 2 || hints[0].Aliases[0] != "飞书" || hints[0].SkillRoot != filepath.Join(root, "skills") {
		t.Fatalf("routing hints = %#v", hints)
	}
	hints[0].Aliases[0] = "mutated"
	if got := broker.RoutingHints()[0].Aliases[0]; got != "飞书" {
		t.Fatalf("routing aliases leaked mutable route state: %q", got)
	}
	for _, removed := range []string{"connector.capabilities", "connector.skills", "connector.skill.read", "connector.invoke"} {
		if _, invokeErr := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: removed}); !errors.Is(invokeErr, cliservice.ErrCommandNotFound) {
			t.Fatalf("removed command %q error = %v", removed, invokeErr)
		}
	}
}

func TestConnectorBrokerRejectsInactiveConnector(t *testing.T) {
	broker, err := NewConnectorBroker(NewConnectorRuntimeRegistry())
	if err != nil {
		t.Fatal(err)
	}
	available, err := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorAvailableCommandID})
	if err != nil || len(available.Value["connectors"].([]implementationhost.ConnectorSummary)) != 0 {
		t.Fatalf("inactive connector available = %#v, error = %v", available.Value, err)
	}
	if hints := broker.RoutingHints(); len(hints) != 0 {
		t.Fatalf("inactive routing hints = %#v", hints)
	}
}
