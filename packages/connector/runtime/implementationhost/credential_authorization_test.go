package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

func TestAttachCredentialBrokerPreservesEmptyNativeCLIArguments(t *testing.T) {
	preparedPath := t.TempDir()
	if err := os.WriteFile(filepath.Join(preparedPath, "credential-broker.mjs"), []byte("export {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	route := &connectorRoute{cliLaunch: &managedCLILaunch{
		arguments: []string{}, cwd: preparedPath,
		executable: connectorruntime.ConnectorExecutable{Path: "/managed/lark-cli"},
	}}
	err := (&Host{}).attachCredentialBroker(route, &market.ManagedCredentialBroker{
		Entrypoint: "credential-broker.mjs", TimeoutMS: 300_000,
	}, market.PreparedArtifactReceipt{PreparedPath: preparedPath}, connectorruntime.ConnectorExecutable{}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(route.credentialBrokerLaunch.cliLaunch)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"arguments":[]`) {
		t.Fatalf("credential broker CLI launch = %s, want empty JSON array", payload)
	}
}

type credentialAuthorizationHostStub struct {
	route       *connectorRoute
	connections []agentruntime.ProcessConnection
	requests    []credentialBrokerRequest
}

func (stub *credentialAuthorizationHostStub) authorizationRoute(market.Connector) (*connectorRoute, error) {
	if stub.route == nil {
		return nil, errors.New("route unavailable")
	}
	return stub.route, nil
}

func (stub *credentialAuthorizationHostStub) startCredentialBroker(
	_ context.Context,
	_ *connectorRoute,
	request credentialBrokerRequest,
) (agentruntime.ProcessConnection, uint64, error) {
	stub.requests = append(stub.requests, request)
	if len(stub.connections) == 0 {
		return nil, 0, errors.New("unexpected credential broker start")
	}
	connection := stub.connections[0]
	stub.connections = stub.connections[1:]
	return connection, uint64(len(stub.requests)), nil
}

type credentialBrokerConnection struct {
	frames chan agentruntime.ProcessFrame
}

func newCredentialBrokerConnection() *credentialBrokerConnection {
	return &credentialBrokerConnection{frames: make(chan agentruntime.ProcessFrame, 8)}
}

func (*credentialBrokerConnection) Send([]byte) error { return nil }
func (*credentialBrokerConnection) Close() error      { return nil }
func (*credentialBrokerConnection) CloseInput() error { return nil }
func (*credentialBrokerConnection) Terminate() error  { return nil }
func (*credentialBrokerConnection) Kill() error       { return nil }

func (connection *credentialBrokerConnection) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-connection.frames
	if !ok {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func TestManagedCredentialAuthorizationContinuesConnectorOwnedBroker(t *testing.T) {
	connection := newCredentialBrokerConnection()
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "default\x00lark-cli", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
			timeout: 5 * time.Minute,
			allowedHosts: map[string]struct{}{
				"open.feishu.cn":     {},
				"accounts.feishu.cn": {},
			},
		}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	request := market.AuthorizationStartRequest{OperationID: "authorize-1", Connector: market.Connector{Key: "lark-cli"}}

	firstResult := make(chan market.AuthorizationSession, 1)
	firstError := make(chan error, 1)
	go func() {
		session, err := provider.Begin(context.Background(), request)
		firstResult <- session
		firstError <- err
	}()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://open.feishu.cn/page/cli?user_code=opaque"}` + "\n")}
	if err := <-firstError; err != nil {
		t.Fatal(err)
	}
	first := <-firstResult
	if first.State != market.AuthorizationStatePending || first.AuthorizationURL != "https://open.feishu.cn/page/cli?user_code=opaque" {
		t.Fatalf("first session = %#v", first)
	}

	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.feishu.cn/device?user_code=user"}` + "\n")}
	second := awaitAuthorizationSession(t, provider, request, "https://accounts.feishu.cn/device?user_code=user")
	if second.State != market.AuthorizationStatePending {
		t.Fatalf("second session = %#v", second)
	}

	exitCode := 0
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"connected"}` + "\n"), ExitCode: &exitCode}
	connected := awaitAuthorizationSession(t, provider, request, "")
	if connected.State != market.AuthorizationStateConnected {
		t.Fatalf("connected session = %#v", connected)
	}
	if !reflect.DeepEqual(host.requests, []credentialBrokerRequest{{Protocol: market.CredentialBrokerProtocolV1, Operation: "begin"}}) {
		t.Fatalf("broker requests = %#v", host.requests)
	}
}

func TestManagedCredentialAuthorizationDisconnectUsesBrokerProtocol(t *testing.T) {
	exitCode := 0
	connection := newCredentialBrokerConnection()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"disconnected"}` + "\n"), ExitCode: &exitCode}
	host := &credentialAuthorizationHostStub{
		route:       &connectorRoute{id: "default\x00lark-cli", credentialBrokerLaunch: &managedCredentialBrokerLaunch{timeout: 5 * time.Minute}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	err := provider.Disconnect(context.Background(), market.AuthorizationDisconnectRequest{Connector: market.Connector{Key: "lark-cli"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(host.requests, []credentialBrokerRequest{{Protocol: market.CredentialBrokerProtocolV1, Operation: "disconnect"}}) {
		t.Fatalf("broker requests = %#v", host.requests)
	}
}

func TestManagedCredentialAuthorizationSharesOneBrokerAcrossConcurrentBegins(t *testing.T) {
	connection := newCredentialBrokerConnection()
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "default\x00example", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
			timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"accounts.example.com": {}},
		}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	results := make(chan market.AuthorizationSession, 2)
	errors := make(chan error, 2)
	for index := 0; index < 2; index++ {
		go func() {
			session, err := provider.Begin(context.Background(), market.AuthorizationStartRequest{
				OperationID: "authorize", Connector: market.Connector{Key: "example"},
			})
			results <- session
			errors <- err
		}()
	}
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com/device"}` + "\n")}
	for index := 0; index < 2; index++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
		if result := <-results; result.AuthorizationURL != "https://accounts.example.com/device" {
			t.Fatalf("authorization session = %#v", result)
		}
	}
	if len(host.requests) != 1 {
		t.Fatalf("credential broker starts = %d, want 1", len(host.requests))
	}
}

func TestManagedCredentialAuthorizationRestartsFailedBrokerOnFirstRetry(t *testing.T) {
	failedConnection := newCredentialBrokerConnection()
	retryConnection := newCredentialBrokerConnection()
	route := &connectorRoute{id: "default\x00example", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
		timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"accounts.example.com": {}},
	}}
	host := &credentialAuthorizationHostStub{
		route: route, connections: []agentruntime.ProcessConnection{failedConnection, retryConnection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	firstRequest := market.AuthorizationStartRequest{OperationID: "authorize-first", Connector: market.Connector{Key: "example"}}
	firstResult := make(chan market.AuthorizationSession, 1)
	firstError := make(chan error, 1)
	go func() {
		session, err := provider.Begin(context.Background(), firstRequest)
		firstResult <- session
		firstError <- err
	}()
	failedConnection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com/first"}` + "\n")}
	if err := <-firstError; err != nil {
		t.Fatal(err)
	}
	if result := <-firstResult; result.AuthorizationURL != "https://accounts.example.com/first" {
		t.Fatalf("first authorization session = %#v", result)
	}
	exitCode := 1
	failedConnection.frames <- agentruntime.ProcessFrame{Stderr: []byte("broker failed"), ExitCode: &exitCode}
	awaitCachedAuthorizationFailure(t, provider, route.id)

	retryConnection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com/retry"}` + "\n")}
	retry, err := provider.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "authorize-retry", Connector: market.Connector{Key: "example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if retry.AuthorizationURL != "https://accounts.example.com/retry" {
		t.Fatalf("retry authorization session = %#v", retry)
	}
	if len(host.requests) != 2 {
		t.Fatalf("credential broker starts = %d, want 2", len(host.requests))
	}
}

func awaitCachedAuthorizationFailure(t *testing.T, provider *managedCredentialAuthorizationProvider, routeID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		provider.mu.Lock()
		session := provider.sessions[routeID]
		provider.mu.Unlock()
		if session != nil {
			_, _, err := session.snapshot()
			if err != nil {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("credential broker session did not fail")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestManagedCredentialAuthorizationRejectsUntrustedURL(t *testing.T) {
	connection := newCredentialBrokerConnection()
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "default\x00example", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
			timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"accounts.example.com": {}},
		}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	result := make(chan error, 1)
	go func() {
		_, err := provider.Begin(context.Background(), market.AuthorizationStartRequest{
			OperationID: "authorize-unsafe", Connector: market.Connector{Key: "example"},
		})
		result <- err
	}()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com.attacker.test/login"}` + "\n")}
	if err := <-result; err == nil {
		t.Fatal("untrusted authorization URL was accepted")
	}
}

func awaitAuthorizationSession(
	t *testing.T,
	provider *managedCredentialAuthorizationProvider,
	request market.AuthorizationStartRequest,
	wantedURL string,
) market.AuthorizationSession {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		session, err := provider.Begin(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		if session.AuthorizationURL == wantedURL &&
			(wantedURL != "" || session.State == market.AuthorizationStateConnected) {
			return session
		}
		if time.Now().After(deadline) {
			t.Fatalf("authorization session did not reach URL %q: %#v", wantedURL, session)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSafeCredentialBrokerURLRequiresExactHTTPSHost(t *testing.T) {
	allowed := map[string]struct{}{"accounts.feishu.cn": {}}
	if !safeCredentialBrokerURL("https://accounts.feishu.cn/device", allowed) {
		t.Fatal("allowed credential broker URL was rejected")
	}
	for _, value := range []string{
		"http://accounts.feishu.cn/device",
		"https://accounts.feishu.cn.attacker.test/device",
		"https://user@accounts.feishu.cn/device",
		"https://accounts.feishu.cn:444/device",
	} {
		if safeCredentialBrokerURL(value, allowed) {
			t.Fatalf("unsafe credential broker URL was accepted: %s", value)
		}
	}
}
