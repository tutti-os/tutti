package connectormarket

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func TestConnectorCommandProviderReadsValidatedRouteProjection(t *testing.T) {
	host, registry, connector, generation := testCLIHostWithSetup(t, &connectorProcessStub{}, func(root string) {
		skillDir := filepath.Join(root, "skills", "diagnostic")
		if err := os.MkdirAll(skillDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte("---\nname: run-diagnostic\ndescription: Run one diagnostic.\n---\n\n# Run Diagnostic\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	})
	connector.Release.Manifest.AgentRouting = &market.AgentRouting{Aliases: []string{"飞书", "Feishu"}}
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{OperationID: "op-1", ConnectionID: "workspace-1",
		Connector: connector, Enabled: true, Generation: generation}); err != nil {
		t.Fatal(err)
	}
	provider := NewConnectorCommandProvider(registry)
	if capabilities := provider.Capabilities(context.Background(), cliservice.InvokeContext{}); len(capabilities) != 1 || capabilities[0].ID != connectorAvailableCommandID {
		t.Fatalf("provider capabilities = %#v", capabilities)
	}
	available, err := provider.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorAvailableCommandID})
	if err != nil {
		t.Fatal(err)
	}
	connectors, ok := available.Value["connectors"].([]implementationhost.ConnectorSummary)
	if !ok || len(connectors) != 1 || connectors[0].Name != connector.Release.Manifest.DisplayName ||
		len(connectors[0].Skills) != 1 || connectors[0].Skills[0].Name != "run-diagnostic" ||
		len(connectors[0].Interfaces) != 1 || connectors[0].Interfaces[0].Kind != "cli" {
		t.Fatalf("available = %#v", available.Value)
	}
	if _, err := provider.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: "connector.invoke"}); !errors.Is(err, cliservice.ErrCommandNotFound) {
		t.Fatalf("removed command error = %v", err)
	}
}

func TestConnectorCommandProviderRejectsMissingRegistry(t *testing.T) {
	provider := NewConnectorCommandProvider(nil)
	if _, err := provider.Invoke(context.Background(), cliservice.InvokeRequest{CommandID: connectorAvailableCommandID}); !errors.Is(err, cliservice.ErrServiceUnavailable) {
		t.Fatalf("error = %v", err)
	}
}

func TestConnectorCommandProviderOmitsStoppedRuntime(t *testing.T) {
	host, registry, connector, generation := testCLIHostWithSetup(t, &connectorProcessStub{}, nil)
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{
		OperationID: "op-1", ConnectionID: "workspace-1", Connector: connector, Enabled: true, Generation: generation,
	}); err != nil {
		t.Fatal(err)
	}
	generation.Generation++
	if _, err := host.Reconcile(context.Background(), market.RuntimeReconcileRequest{
		OperationID: "op-2", ConnectionID: "workspace-1", Connector: connector, Enabled: false, Generation: generation,
	}); err != nil {
		t.Fatal(err)
	}

	available, err := NewConnectorCommandProvider(registry).Invoke(
		context.Background(), cliservice.InvokeRequest{CommandID: connectorAvailableCommandID},
	)
	if err != nil {
		t.Fatal(err)
	}
	connectors, ok := available.Value["connectors"].([]implementationhost.ConnectorSummary)
	if !ok || len(connectors) != 0 {
		t.Fatalf("available connectors = %#v, want none after the Connector runtime stops", available.Value["connectors"])
	}
}
