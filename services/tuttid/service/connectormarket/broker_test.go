package connectormarket

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestConnectorBrokerAdaptsPublicDiscoverySkillsAndInvocation(t *testing.T) {
	host, commands, connector, generation := testCLIHost(t, &connectorProcessStub{})
	root := host.artifacts.(preparedResolverStub).receipt.PreparedPath
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation}); err != nil {
		t.Fatal(err)
	}
	skillDir := filepath.Join(root, "skills", "diagnostic")
	if err := os.MkdirAll(skillDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tutti.connector.json"), []byte(`{"name":{"en-US":"Demo Package"},"description":{"en-US":"Package description"},"skills":["./skills/diagnostic/SKILL.md"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: run-diagnostic\ndescription: Run one diagnostic.\n---\n\n# Run Diagnostic\n\nUse the broker.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	broker, err := NewConnectorBroker(commands)
	if err != nil {
		t.Fatal(err)
	}
	if capabilities := broker.Capabilities(context.Background(), cliservice.InvokeContext{}); len(capabilities) != 5 {
		t.Fatalf("broker capabilities = %#v", capabilities)
	}
	available, err := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorAvailableCommandID})
	if err != nil {
		t.Fatal(err)
	}
	connectors, ok := available.Value["connectors"].([]implementationhost.ConnectorSummary)
	if !ok || len(connectors) != 1 || connectors[0].Name != "Demo Package" {
		t.Fatalf("available = %#v", available.Value)
	}
	discovered, err := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorCapabilitiesCommandID,
		Input: map[string]any{"connector": "github"}})
	if err != nil {
		t.Fatal(err)
	}
	capabilities, ok := discovered.Value["capabilities"].([]implementationhost.CapabilitySummary)
	if !ok || len(capabilities) != 1 || capabilities[0].ID != "connector.github.cli.status" ||
		capabilities[0].Kind != "cli" || capabilities[0].Name != "status" || capabilities[0].InputSchema["type"] != "object" {
		t.Fatalf("capabilities = %#v", discovered.Value)
	}
	skills, err := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorSkillsCommandID,
		Input: map[string]any{"connector": "github"}})
	if err != nil || len(skills.Value["skills"].([]implementationhost.SkillSummary)) != 1 {
		t.Fatalf("skills = %#v err = %v", skills.Value, err)
	}
	read, err := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorSkillReadCommandID,
		Input: map[string]any{"connector": "github", "skill": "run-diagnostic"}})
	if err != nil || !strings.Contains(read.Value["content"].(string), "Use the broker") {
		t.Fatalf("read = %#v err = %v", read.Value, err)
	}
	invoked, err := broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorInvokeCommandID,
		Input: map[string]any{"connector": "github", "capability": "connector.github.cli.status", "input-json": `{}`}})
	if err != nil || invoked.Value["ok"] != true {
		t.Fatalf("invoke = %#v err = %v", invoked.Value, err)
	}
	_, err = broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorInvokeCommandID,
		Input: map[string]any{"connector": "github", "capability": "status", "input-json": `{}`}})
	if got := cliservice.InvokeErrorReason(err); got != "connector_capability_not_found" {
		t.Fatalf("short capability id error = %q, want connector_capability_not_found: %v", got, err)
	}
}

func TestConnectorBrokerRejectsInactiveConnector(t *testing.T) {
	broker, err := NewConnectorBroker(NewConnectorCommandRegistry())
	if err != nil {
		t.Fatal(err)
	}
	_, err = broker.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorSkillsCommandID,
		Input: map[string]any{"connector": "demo"}})
	if err == nil || !strings.Contains(err.Error(), "runtime is not active") {
		t.Fatalf("inactive connector error = %v", err)
	}
}
