package implementationhost

import (
	"context"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
	"github.com/tutti-os/tutti/packages/connector/runtime/command"
)

func TestCommandRegistryUsesOpaqueCanonicalCapabilityIDs(t *testing.T) {
	registry := NewCommandRegistry()
	routes := connectorruntime.NewRouteTable()
	registry.attach(routes)

	canonicalID := "connector.demo.v2.cli.account.status"
	invoked := false
	commitTestConnectorRoute(t, routes, "demo.v2", connectorCommand{
		capability: command.Capability{ID: canonicalID, Description: "Read account status", InputSchema: map[string]any{"type": "object"}},
		kind:       "cli",
		name:       "account.status",
		invoke: func(context.Context, command.InvokeRequest) (command.Output, error) {
			invoked = true
			return command.Output{Value: map[string]any{"ok": true}}, nil
		},
	})

	capabilities := registry.CapabilitiesForConnector("demo.v2")
	if len(capabilities) != 1 || capabilities[0].ID != canonicalID || capabilities[0].Kind != "cli" ||
		capabilities[0].Name != "account.status" || capabilities[0].InputSchema["type"] != "object" {
		t.Fatalf("capabilities = %#v", capabilities)
	}

	output, err := registry.InvokeConnector(context.Background(), "demo.v2", canonicalID, command.InvokeRequest{})
	if err != nil || !invoked || output.Value["ok"] != true {
		t.Fatalf("canonical invoke = %#v, invoked=%v, err=%v", output, invoked, err)
	}

	invoked = false
	_, err = registry.InvokeConnector(context.Background(), "demo.v2", "account.status", command.InvokeRequest{})
	if code := command.ErrorCode(err); code != "connector_capability_not_found" || invoked {
		t.Fatalf("short id error code = %q, invoked=%v, err=%v", code, invoked, err)
	}
}

func TestCommandRegistryRejectsCapabilityFromDifferentConnector(t *testing.T) {
	registry := NewCommandRegistry()
	routes := connectorruntime.NewRouteTable()
	registry.attach(routes)

	commitTestConnectorRoute(t, routes, "alpha", connectorCommand{
		capability: command.Capability{ID: "connector.alpha.cli.run"}, kind: "cli", name: "run",
		invoke: func(context.Context, command.InvokeRequest) (command.Output, error) { return command.Output{}, nil },
	})
	commitTestConnectorRoute(t, routes, "beta", connectorCommand{
		capability: command.Capability{ID: "connector.beta.cli.run"}, kind: "cli", name: "run",
		invoke: func(context.Context, command.InvokeRequest) (command.Output, error) { return command.Output{}, nil },
	})

	_, err := registry.InvokeConnector(context.Background(), "alpha", "connector.beta.cli.run", command.InvokeRequest{})
	if code := command.ErrorCode(err); code != "connector_capability_connector_mismatch" {
		t.Fatalf("connector mismatch error code = %q, want connector_capability_connector_mismatch: %v", code, err)
	}
}

func commitTestConnectorRoute(t *testing.T, routes *connectorruntime.RouteTable, connectorKey string, registered connectorCommand) {
	t.Helper()
	route := &connectorRoute{
		id:            connectorRouteKey("default", connectorKey),
		connectionID:  "default",
		connectorKey:  connectorKey,
		releaseDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		generation:    market.HostGeneration{BootEpoch: "boot", Generation: 1},
		capabilities:  map[string]connectorCommand{registered.capability.ID: registered},
		processes:     connectorruntime.NewProcessGroup(),
	}
	if err := routes.Commit(route); err != nil {
		t.Fatal(err)
	}
}
