package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
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
	listErr    error
}

func (client *remoteMCPClientStub) Call(_ context.Context, method string, _ any) (json.RawMessage, error) {
	client.calls = append(client.calls, method)
	if method == "tools/list" {
		if client.listErr != nil {
			return nil, client.listErr
		}
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

func TestBuildRemoteRouteReusesInProcessToolsListForSameAuthorizationIdentity(t *testing.T) {
	client := &remoteMCPClientStub{}
	host := &Host{
		remoteMCPClientFactory: &remoteMCPFactoryRecorder{client: client},
		remoteMCPTools:         newRemoteMCPToolCache(),
	}
	request := testRemoteMCPRouteRequest("documents", 3, 12)
	if _, err := host.buildRemoteRoute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	request.Generation.Generation++
	if _, err := host.buildRemoteRoute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if got := countRemoteMCPCalls(client.calls, "tools/list"); got != 1 {
		t.Fatalf("tools/list calls = %d, want 1; calls=%#v", got, client.calls)
	}
	if got := countRemoteMCPCalls(client.calls, "server/discover"); got != 2 {
		t.Fatalf("server/discover calls = %d, want 2; calls=%#v", got, client.calls)
	}
}

func TestBuildRemoteRouteReloadsToolsListWhenAuthorizationIdentityChanges(t *testing.T) {
	client := &remoteMCPClientStub{}
	host := &Host{
		remoteMCPClientFactory: &remoteMCPFactoryRecorder{client: client},
		remoteMCPTools:         newRemoteMCPToolCache(),
	}
	request := testRemoteMCPRouteRequest("documents", 3, 12)
	if _, err := host.buildRemoteRoute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	request.ConnectionVersion = 4
	if _, err := host.buildRemoteRoute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if got := countRemoteMCPCalls(client.calls, "tools/list"); got != 2 {
		t.Fatalf("tools/list calls = %d, want 2; calls=%#v", got, client.calls)
	}
}

func TestBuildRemoteRouteDoesNotCacheAuthorizationRequiredToolsList(t *testing.T) {
	client := &remoteMCPClientStub{listErr: &mcp.ModernHTTPError{
		StatusCode: http.StatusPreconditionRequired,
		Cause:      &mcp.RPCError{Code: -33001, Message: "authorization required"},
	}}
	host := &Host{
		remoteMCPClientFactory: &remoteMCPFactoryRecorder{client: client},
		remoteMCPTools:         newRemoteMCPToolCache(),
	}
	request := testRemoteMCPRouteRequest("gmail", 3, 12)
	if _, err := host.buildRemoteRoute(context.Background(), request); err == nil {
		t.Fatal("expected authorization-required tools/list to fail")
	}
	client.listErr = nil
	if _, err := host.buildRemoteRoute(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if got := countRemoteMCPCalls(client.calls, "tools/list"); got != 2 {
		t.Fatalf("failed tools/list was cached: calls=%#v", client.calls)
	}
}

func TestBuildRemoteRouteMapsAuthorizationRequired(t *testing.T) {
	client := &remoteMCPClientStub{listErr: &mcp.ModernHTTPError{
		StatusCode: http.StatusPreconditionRequired,
		Cause:      &mcp.RPCError{Code: -33001, Message: "authorization required"},
	}}
	host := &Host{remoteMCPClientFactory: &remoteMCPFactoryRecorder{client: client}}
	implementation := market.RemoteStreamableHTTPImplementation{
		ProtocolVersion: mcp.ModernProtocolVersion, BindingRef: "gmail.primary", ContractVersion: 1,
		BindingContractHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}
	_, err := host.buildRemoteRoute(context.Background(), market.RuntimeReconcileRequest{
		OperationID: "operation-1", ConnectionID: "connection-1", Scope: market.OperationScope{AccountID: "account-1"},
		Connector: market.Connector{Key: "gmail", Release: market.Release{
			Version: "0.1.3", ReleaseDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			Manifest: market.Manifest{Implementation: market.Implementation{
				Kind: market.ImplementationKindRemoteStreamableHTTP, RemoteStreamableHTTP: &implementation,
			}},
		}},
		Generation: market.HostGeneration{BootEpoch: "boot-1", Generation: 1},
	})
	var domain *market.DomainError
	if !errors.As(err, &domain) || domain.Code != market.ErrorCodeAuthorizationFailed || domain.Retryable {
		t.Fatalf("buildRemoteRoute error = %#v", err)
	}
	if !client.closed {
		t.Fatal("authorization-required discover/list left the remote MCP client open")
	}
}

func testRemoteMCPRouteRequest(connectorKey string, connectionVersion, serverRevision uint64) market.RuntimeReconcileRequest {
	implementation := market.RemoteStreamableHTTPImplementation{
		ProtocolVersion: mcp.ModernProtocolVersion, BindingRef: connectorKey + ".primary", ContractVersion: 1,
		BindingContractHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	}
	return market.RuntimeReconcileRequest{
		OperationID: "operation-1", ConnectionID: "connection-1", Scope: market.OperationScope{AccountID: "account-1"},
		Connector: market.Connector{Key: connectorKey, Release: market.Release{
			Version: "1.2.3", ReleaseDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			Manifest: market.Manifest{Implementation: market.Implementation{
				Kind: market.ImplementationKindRemoteStreamableHTTP, RemoteStreamableHTTP: &implementation,
			}},
		}},
		Generation:        market.HostGeneration{BootEpoch: "boot-1", Generation: 1},
		ConnectionVersion: connectionVersion,
		ServerRevision:    serverRevision,
	}
}

func countRemoteMCPCalls(calls []string, method string) int {
	count := 0
	for _, call := range calls {
		if call == method {
			count++
		}
	}
	return count
}
