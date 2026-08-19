package implementationhost

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

type remoteMCPFactoryRecorder struct {
	request RemoteMCPClientRequest
	client  RemoteMCPClient
}

func (factory *remoteMCPFactoryRecorder) NewRemoteMCPClient(_ context.Context, request RemoteMCPClientRequest) (RemoteMCPClient, error) {
	factory.request = request
	return factory.client, nil
}

type remoteMCPClientStub struct {
	calls      []string
	registered []string
	closed     bool
}

func (client *remoteMCPClientStub) Call(_ context.Context, method string, _ any) (json.RawMessage, error) {
	client.calls = append(client.calls, method)
	if method == "tools/list" {
		return json.RawMessage(`{"resultType":"complete","tools":[{"name":"search","description":"Search","inputSchema":{"type":"object"}}]}`), nil
	}
	return json.RawMessage(`{"resultType":"complete"}`), nil
}

func (client *remoteMCPClientStub) RegisterTool(name string, _ map[string]any) error {
	client.registered = append(client.registered, name)
	return nil
}

func (*remoteMCPClientStub) ReplaceTools(map[string]map[string]any) error { return nil }

func (client *remoteMCPClientStub) Close(context.Context) error {
	client.closed = true
	return nil
}

func TestBuildRemoteRouteUsesProductClientFactoryWithLifecycleIdentity(t *testing.T) {
	client := &remoteMCPClientStub{}
	factory := &remoteMCPFactoryRecorder{client: client}
	host := &Host{remoteMCPClientFactory: factory}
	implementation := market.RemoteStreamableHTTPImplementation{
		ProtocolVersion: mcp.ModernProtocolVersion, BindingRef: "documents.primary", ContractVersion: 1,
		BindingContractHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}
	generation := market.HostGeneration{BootEpoch: "boot-1", Generation: 7}
	request := market.RuntimeReconcileRequest{
		OperationID: "operation-1", ConnectionID: "connection-1", Scope: market.OperationScope{AccountID: "account-1"},
		Connector: market.Connector{Key: "documents", Release: market.Release{
			Version: "1.2.3", ReleaseDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			Manifest: market.Manifest{Implementation: market.Implementation{
				Kind: market.ImplementationKindRemoteStreamableHTTP, RemoteStreamableHTTP: &implementation,
			}},
		}},
		Generation: generation,
	}
	route, err := host.buildRemoteRoute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	want := RemoteMCPClientRequest{
		OperationID: "operation-1", ConnectionID: "connection-1", ConnectorKey: "documents", AccountID: "account-1",
		ReleaseDigest: request.Connector.Release.ReleaseDigest, Version: "1.2.3", Generation: generation, Implementation: implementation,
	}
	if !reflect.DeepEqual(factory.request, want) {
		t.Fatalf("factory request = %#v, want %#v", factory.request, want)
	}
	if route.connectorKey != "documents" || route.connectorVersion != "1.2.3" || route.remoteMCP != client ||
		!reflect.DeepEqual(client.calls, []string{"server/discover", "tools/list"}) ||
		!reflect.DeepEqual(client.registered, []string{"search"}) {
		t.Fatalf("remote client bootstrap = provenance:%s@%s route:%v calls:%#v registered:%#v",
			route.connectorKey, route.connectorVersion, route.remoteMCP == client, client.calls, client.registered)
	}
}
